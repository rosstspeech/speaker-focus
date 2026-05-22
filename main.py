import asyncio
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from speechmatics.voice import (
    VoiceAgentClient,
    VoiceAgentConfigPreset,
    SpeakerFocusConfig,
    SpeakerFocusMode,
    AgentServerMessageType,
)
from speechmatics.rt import (
    AsyncClient,
    TranscriptionConfig,
    SpeakerDiarizationConfig,
    SpeakerIdentifier,
    AudioFormat,
    AudioEncoding,
    ServerMessageType,
)

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Speaker Focus")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

ENROLLED_FILE = "enrolled_speakers.json"


def load_enrolled() -> dict:
    try:
        with open(ENROLLED_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_enrolled(data: dict) -> None:
    with open(ENROLLED_FILE, "w") as f:
        json.dump(data, f, indent=2)


# ── HTTP endpoints ─────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/enrolled-speakers")
async def get_enrolled():
    return {"speakers": list(load_enrolled().keys())}


@app.delete("/api/enrolled-speakers/{name}")
async def delete_enrolled(name: str):
    data = load_enrolled()
    if name not in data:
        raise HTTPException(status_code=404, detail="Speaker not found")
    del data[name]
    save_enrolled(data)
    return {"deleted": name}


# ── Enrollment WebSocket ───────────────────────────────────────────────────────

@app.websocket("/ws/enroll")
async def enroll_ws(websocket: WebSocket, name: str):
    await websocket.accept()

    api_key = os.environ.get("SPEECHMATICS_API_KEY")
    if not api_key:
        await websocket.send_json({"type": "error", "message": "SPEECHMATICS_API_KEY is not set"})
        await websocket.close()
        return

    name = name.strip()
    if not name:
        await websocket.send_json({"type": "error", "message": "Speaker name is required"})
        await websocket.close()
        return

    speakers_future: asyncio.Future = asyncio.get_running_loop().create_future()

    async with AsyncClient(api_key=api_key) as rt_client:

        @rt_client.on(ServerMessageType.SPEAKERS_RESULT)
        def on_speakers(msg):
            if not speakers_future.done():
                speakers_future.set_result(msg)

        rt_config = TranscriptionConfig(
            language="en",
            diarization="speaker",
            speaker_diarization_config=SpeakerDiarizationConfig(max_speakers=2),
        )
        audio_fmt = AudioFormat(encoding=AudioEncoding.PCM_S16LE, sample_rate=16000)

        got_stop = False
        try:
            await rt_client.start_session(transcription_config=rt_config, audio_format=audio_fmt)
            await websocket.send_json({"type": "recording"})
            logger.info("Enrollment recording started for '%s'", name)

            while True:
                frame = await websocket.receive()
                if frame.get("type") == "websocket.disconnect":
                    break
                if "bytes" in frame and frame["bytes"]:
                    await rt_client.send_audio(frame["bytes"])
                elif "text" in frame and frame["text"]:
                    try:
                        ctrl = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue
                    if ctrl.get("type") == "stop":
                        got_stop = True
                        break

            if not got_stop:
                return

            await rt_client.send_message({"message": "GetSpeakers", "final": True})
            await rt_client.stop_session()

            if not speakers_future.done():
                try:
                    await asyncio.wait_for(speakers_future, timeout=8)
                except asyncio.TimeoutError:
                    await websocket.send_json({
                        "type": "error",
                        "message": "No speaker data returned — try speaking for longer.",
                    })
                    return

            result = speakers_future.result()
            if isinstance(result, dict):
                speakers = result.get("speakers", [])
            else:
                speakers = getattr(result, "speakers", [])

            if not speakers:
                await websocket.send_json({
                    "type": "error",
                    "message": "No speaker detected. Try speaking for at least 5 seconds.",
                })
                return

            spk = speakers[0]
            identifiers = (
                spk.get("speaker_identifiers", []) if isinstance(spk, dict)
                else getattr(spk, "speaker_identifiers", [])
            )

            if not identifiers:
                await websocket.send_json({
                    "type": "error",
                    "message": "Could not generate a speaker identifier.",
                })
                return

            data = load_enrolled()
            data[name] = identifiers
            save_enrolled(data)
            logger.info("Enrolled '%s' with %d identifier(s)", name, len(identifiers))

            await websocket.send_json({"type": "enrolled", "name": name})

        except WebSocketDisconnect:
            logger.info("Enroll client disconnected")
        except Exception as exc:
            logger.error("Enrollment error: %s", exc, exc_info=True)
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except Exception:
                pass


# ── Live session WebSocket ─────────────────────────────────────────────────────

@app.websocket("/ws")
async def session_ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket accepted from %s", websocket.client)

    api_key = os.environ.get("SPEECHMATICS_API_KEY")
    if not api_key:
        await websocket.send_json({
            "type": "error",
            "message": "SPEECHMATICS_API_KEY is not set on the server.",
        })
        await websocket.close()
        return

    known_speakers: set[str] = set()
    focused_speaker: str | None = None
    speaker_word_counts: dict[str, int] = {}
    auto_focus_enabled: bool = True

    WARMUP_WORDS = 15
    FOCUS_THRESHOLD = 0.60
    UNFOCUS_THRESHOLD = 0.40

    enrolled = load_enrolled()
    known = [
        SpeakerIdentifier(label=n, speaker_identifiers=ids)
        for n, ids in enrolled.items()
        if ids
    ]
    config = VoiceAgentConfigPreset.CAPTIONS()
    if known:
        config.known_speakers = known

    client = VoiceAgentClient(api_key=api_key, config=config)

    async def send(payload: dict) -> None:
        try:
            await websocket.send_json(payload)
        except Exception:
            pass

    def _apply_focus(speaker: str | None) -> None:
        nonlocal focused_speaker
        focused_speaker = speaker
        if speaker:
            focus_cfg = SpeakerFocusConfig(
                focus_speakers=[speaker],
                focus_mode=SpeakerFocusMode.IGNORE,
            )
        else:
            focus_cfg = SpeakerFocusConfig(
                focus_speakers=sorted(known_speakers) or [""],
                focus_mode=SpeakerFocusMode.IGNORE,
            )
        client.update_diarization_config(focus_cfg)
        logger.info("Focus updated → %s", speaker)
        asyncio.create_task(send({
            "type": "focus_updated",
            "focused_speaker": speaker,
        }))

    def _check_auto_focus() -> None:
        if not auto_focus_enabled:
            logger.debug("Auto-focus disabled (manual override active)")
            return
        total = sum(speaker_word_counts.values())
        logger.info("Auto-focus check: counts=%s total=%d warmup=%d focused=%s",
                    speaker_word_counts, total, WARMUP_WORDS, focused_speaker)
        if total < WARMUP_WORDS:
            return
        if focused_speaker is None:
            for spk, count in speaker_word_counts.items():
                share = count / total
                logger.info("  %s share=%.0f%% threshold=%.0f%%", spk, share * 100, FOCUS_THRESHOLD * 100)
                if share >= FOCUS_THRESHOLD:
                    logger.info("Auto-focusing on %s (%.0f%% of words)", spk, share * 100)
                    try:
                        _apply_focus(spk)
                    except Exception as exc:
                        logger.error("_apply_focus failed: %s", exc, exc_info=True)
                    return
        else:
            focused_share = speaker_word_counts.get(focused_speaker, 0) / total
            if focused_share < UNFOCUS_THRESHOLD:
                logger.info("Auto-unfocusing %s (share dropped to %.0f%%)", focused_speaker, focused_share * 100)
                try:
                    _apply_focus(None)
                except Exception as exc:
                    logger.error("_apply_focus failed: %s", exc, exc_info=True)

    # ── Event handlers ────────────────────────────────────────────────────────

    @client.on(AgentServerMessageType.RECOGNITION_STARTED)
    def on_started(_):
        logger.info("Recognition started")
        asyncio.create_task(send({"type": "session_started"}))

    def _extract_segments(msg):
        segs = getattr(msg, "segments", None)
        if segs is None and isinstance(msg, dict):
            segs = msg.get("segments", [])
        return segs or []

    def _get(seg, key):
        return seg.get(key) if isinstance(seg, dict) else getattr(seg, key, None)

    @client.on(AgentServerMessageType.ADD_SEGMENT)
    def on_segment(msg):
        speaker = None
        texts = []
        for seg in _extract_segments(msg):
            spk = _get(seg, "speaker_id")
            if spk and not spk.startswith("__"):
                speaker = spk
            texts.append(_get(seg, "text") or "")
        if speaker:
            known_speakers.add(speaker)
        text = " ".join(t for t in texts if t)
        if speaker and text:
            speaker_word_counts[speaker] = speaker_word_counts.get(speaker, 0) + len(text.split())
            _check_auto_focus()
        logger.info("SEGMENT [%s]: %s", speaker or "?", text)
        asyncio.create_task(send({
            "type": "segment",
            "text": text,
            "speaker": speaker,
            "speakers": sorted(known_speakers),
        }))

    @client.on(AgentServerMessageType.ADD_PARTIAL_SEGMENT)
    def on_partial(msg):
        speaker = None
        texts = []
        for seg in _extract_segments(msg):
            spk = _get(seg, "speaker_id")
            if spk and not spk.startswith("__"):
                speaker = spk
            texts.append(_get(seg, "text") or "")
        text = " ".join(t for t in texts if t)
        logger.debug("PARTIAL [%s]: %s", speaker or "?", text)
        asyncio.create_task(send({
            "type": "partial",
            "text": text,
            "speaker": speaker,
        }))

    @client.on(AgentServerMessageType.END_OF_TURN)
    def on_eot(msg):
        logger.info("End of turn")
        asyncio.create_task(send({"type": "end_of_turn"}))

    @client.on(AgentServerMessageType.ERROR)
    def on_error(msg):
        logger.error("Speechmatics error: %s", getattr(msg, "message", msg))
        asyncio.create_task(send({
            "type": "error",
            "message": str(getattr(msg, "message", msg)),
        }))

    # ── Session loop ──────────────────────────────────────────────────────────

    try:
        async with client:
            await send({"type": "connected"})
            logger.info("Speechmatics session open")

            while True:
                frame = await websocket.receive()

                if frame.get("type") == "websocket.disconnect":
                    break

                if "bytes" in frame and frame["bytes"]:
                    await client.send_audio(frame["bytes"])
                    continue

                if "text" in frame and frame["text"]:
                    try:
                        msg = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue

                    msg_type = msg.get("type")

                    if msg_type == "set_focus":
                        manual_speaker = msg.get("speaker_id") or None
                        if manual_speaker:
                            auto_focus_enabled = False
                        else:
                            auto_focus_enabled = True
                        _apply_focus(manual_speaker)

                    elif msg_type == "ping":
                        await send({"type": "pong"})

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as exc:
        logger.error("Session error: %s", exc, exc_info=True)
        try:
            await send({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        logger.info("Session closed")
