/**
 * Her ear, on the audio thread. Loaded by src/voice/useAmbient.ts.
 *
 * A real file rather than a blob URL, and that is not a style choice. Worklet
 * modules are governed by script-src, and her security policy does not allow
 * blob: there — so the blob version failed to load, the watchdog fell back to
 * the frame clock, and she went deaf every time the tab lost focus. The HUD
 * said so (EAR — FRAMES) for weeks.
 *
 * All it does is measure loudness and post it back about twenty times a
 * second, with the audio attached. Every decision stays on the main thread.
 */
class Ears extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.frames = 0;
    this.held = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
      this.sum += sum;
      this.count += channel.length;
      this.frames += channel.length;
      this.held.push(channel.slice());
    }

    // Roughly every 50ms. Blocks are 128 frames, which would be 375 messages a
    // second — enough to make the main thread the bottleneck it was not.
    if (this.frames >= sampleRate * 0.05) {
      // The audio travels with the reading: by the time loudness crosses a
      // threshold the first syllable is already past, and the first syllable
      // of "Grace, ..." is the word that decides whether she answers.
      let total = 0;
      for (const block of this.held) total += block.length;
      const audio = new Float32Array(total);
      let at = 0;
      for (const block of this.held) {
        audio.set(block, at);
        at += block.length;
      }
      this.held = [];

      this.port.postMessage(
        {rms: this.count > 0 ? Math.sqrt(this.sum / this.count) : 0, audio},
        [audio.buffer],
      );
      this.sum = 0;
      this.count = 0;
      this.frames = 0;
    }

    return true;
  }
}
registerProcessor('grace-ears', Ears);
