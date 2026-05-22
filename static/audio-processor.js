/**
 * AudioWorklet processor that converts Float32 samples from the Web Audio API
 * into signed 16-bit PCM and posts the buffer to the main thread.
 *
 * If the AudioContext sample rate differs from the target (16 kHz), a simple
 * averaging downsampler is applied so Speechmatics always receives 16 kHz audio.
 */
class AudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const target = options?.processorOptions?.targetSampleRate ?? 16000;
        // `sampleRate` is a global inside an AudioWorkletProcessor
        this._ratio = sampleRate / target;
        this._acc = 0;
        this._accN = 0;
        this._out = [];
    }

    process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this._acc += channel[i];
            this._accN++;

            if (this._accN >= this._ratio) {
                this._out.push(this._acc / this._accN);
                this._acc = 0;
                this._accN = 0;
            }
        }

        if (this._out.length >= 128) {
            const int16 = new Int16Array(this._out.length);
            for (let i = 0; i < this._out.length; i++) {
                const s = Math.max(-1, Math.min(1, this._out[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            this.port.postMessage(int16.buffer, [int16.buffer]);
            this._out = [];
        }

        return true;
    }
}

registerProcessor("audio-processor", AudioProcessor);
