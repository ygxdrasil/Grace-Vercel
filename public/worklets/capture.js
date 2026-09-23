/**
 * Live-voice capture, on the audio thread. Loaded by src/voice/live.ts.
 *
 * A real file for the same reason as ears.js: her security policy refuses
 * blob: scripts, so the blob version never loaded and every live call failed
 * before it began — falling back to record-then-reply, which works, and is
 * slow, which is how it went unnoticed.
 *
 * The rate she listens at arrives as processorOptions.rate.
 */
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.rate = (options && options.processorOptions && options.processorOptions.rate) || 16000;
    this.buffer = [];
    // Roughly 40ms of audio per message. Smaller means more messages than the
    // socket wants; larger is audible as lag before she notices you speaking.
    this.target = Math.round(sampleRate / 25);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) this.buffer.push(channel[i]);

    while (this.buffer.length >= this.target) {
      const slice = this.buffer.splice(0, this.target);
      // Straight-line resample. Entirely good enough for speech.
      const ratio = sampleRate / this.rate;
      const out = new Int16Array(Math.floor(slice.length / ratio));
      for (let i = 0; i < out.length; i += 1) {
        const sample = slice[Math.floor(i * ratio)] || 0;
        // Clamped before scaling: past 1 wraps to the opposite extreme as an
        // integer, which sounds like static exactly when someone raises their voice.
        const clamped = Math.max(-1, Math.min(1, sample));
        out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('capture', Capture);
