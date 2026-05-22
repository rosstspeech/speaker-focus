# Speaker Focus

A real-time speaker diarization demo using the [Speechmatics Voice Agent SDK](https://docs.speechmatics.com). It transcribes multi-speaker audio in the browser, identifies enrolled speakers by voice, and automatically focuses on the primary speaker as they establish dominance in the conversation.

## Features

- **Real-time transcription** with per-speaker labels via Speechmatics
- **Speaker enrollment** — record a voice sample to register a named speaker
- **Auto-focus** — starts unfocused; automatically focuses on whichever speaker accounts for ≥60% of spoken words once a warm-up threshold is met
- **Manual focus override** — click any speaker label in the transcript or speaker card to override auto-focus
- **Hysteresis** — focused speaker is only released when their word-share drops below 40%, preventing rapid oscillation

## Requirements

- Python 3.10+
- A [Speechmatics API key](https://portal.speechmatics.com)
- A modern browser (Chrome recommended — uses AudioWorklet API)

## Setup

```bash
git clone <repo>
cd speaker-focus

python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

pip install -r requirements.txt
```

Create a `.env` file in the project root:

```
SPEECHMATICS_API_KEY=your_api_key_here
```

## Running

```bash
uvicorn main:app --reload
```

Open `http://localhost:8000` in your browser.

## Usage

### Enrolling a speaker (optional)

1. Enter a name in the enrollment panel and click **Enroll**
2. Speak for ~5 seconds when prompted, then click **Stop**
3. The speaker's voice profile is saved to `enrolled_speakers.json`

Enrolled speakers are matched by voice identity across sessions. Unenrolled speakers are labelled S1, S2, etc.

### Live session

1. Click **Start** — the browser will request microphone access
2. Speak; transcription appears in real time with speaker labels
3. Auto-focus activates once one speaker has said ≥5 words and holds ≥60% of total word share
4. Click a speaker label or card to manually override focus; click **Clear Focus** to return to auto mode

### Focus behaviour

| State | Behaviour |
|---|---|
| Unfocused | All speakers transcribed equally |
| Auto-focused | Dominant speaker transcribed; others suppressed (`IGNORE` mode) |
| Manual focus | Auto-focus disabled until **Clear Focus** is clicked |

## Project structure

```
main.py                  # FastAPI server — enrollment + session WebSocket endpoints
static/
  index.html             # Single-page UI
  app.js                 # WebSocket client, audio capture, UI logic
  audio-processor.js     # AudioWorklet — resamples mic audio to 16 kHz PCM
  style.css              # UI styles
enrolled_speakers.json   # Persisted speaker voice profiles (created on first enroll)
requirements.txt
```

## Configuration

Auto-focus thresholds are defined at the top of the session handler in [main.py](main.py):

```python
WARMUP_WORDS      = 5     # minimum total words before auto-focus can trigger
FOCUS_THRESHOLD   = 0.60  # word-share required to gain focus
UNFOCUS_THRESHOLD = 0.40  # word-share below which focus is released
```
