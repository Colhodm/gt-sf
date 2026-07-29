/**
 * Physically-informed engine synthesis.
 *
 * An engine note is NOT a sustained harmonic tone — it is a train of discrete
 * exhaust pressure pulses propagating through a resonant pipe. Synthesising it
 * as stacked oscillators (the obvious approach) produces a buzzy drone that
 * sounds nothing like an engine, because the pulse structure is the whole
 * character.
 *
 * This follows Farnell's model: each cylinder contributes one positive
 * half-cycle of a cosine per four-stroke cycle, summed per exhaust bank and
 * fed through Karplus-Strong style delay resonators standing in for the
 * headers and silencer.
 *
 * Crucially the cylinders are grouped into banks, because that is where engine
 * character actually comes from:
 *   - Flat-six and flat-plane V8: evenly spaced pulses within each bank, so
 *     they wail and rasp cleanly.
 *   - Cross-plane V8: unevenly spaced pulses within each bank, which is the
 *     origin of the classic lopey American burble.
 */

const TAU = Math.PI * 2;

/** Delay line with a damping lowpass in the feedback path — an exhaust pipe. */
class Resonator {
  constructor(sampleRate, hz, feedback, damping) {
    this.len = Math.max(2, Math.round(sampleRate / hz));
    this.buf = new Float32Array(this.len);
    this.idx = 0;
    this.fb = feedback;
    this.damp = damping;
    this.lp = 0;
  }

  process(x) {
    const y = this.buf[this.idx];
    this.lp += this.damp * (y - this.lp);
    let v = x + this.lp * this.fb;
    // Soft clip keeps the feedback loop from blowing up under heavy drive.
    if (v > 1.6) v = 1.6;
    else if (v < -1.6) v = -1.6;
    this.buf[this.idx] = v;
    this.idx = this.idx + 1 === this.len ? 0 : this.idx + 1;
    return y;
  }
}

class Bank {
  constructor(sampleRate, angles, resonatorSpecs) {
    this.angles = Float32Array.from(angles);
    this.resonators = resonatorSpecs.map((r) => new Resonator(sampleRate, r.hz, r.fb, r.damp));
    // DC blocker: a sum of one-sided pressure bumps has a large DC component.
    this.dcX = 0;
    this.dcY = 0;
  }

  /** Summed cylinder pressure at a point in the 4-stroke cycle (phase 0..1). */
  drive(phase, openFraction) {
    let sum = 0;
    for (let i = 0; i < this.angles.length; i++) {
      let d = phase - this.angles[i];
      if (d < 0) d += 1;
      if (d < openFraction) {
        // Raised cosine: a smooth blast as the exhaust valve opens and closes.
        sum += 0.5 * (1 - Math.cos((TAU * d) / openFraction));
      }
    }
    return sum / this.angles.length;
  }

  process(raw) {
    // High-pass out the DC offset before it saturates the resonators.
    const y = raw - this.dcX + 0.9975 * this.dcY;
    this.dcX = raw;
    this.dcY = y;

    let out = 0;
    for (let i = 0; i < this.resonators.length; i++) out += this.resonators[i].process(y);
    return out / this.resonators.length;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Crankshaft revolutions per second.
      { name: 'rps', defaultValue: 13, minValue: 0, maxValue: 300, automationRate: 'a-rate' },
      { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const o = options.processorOptions;
    this.banks = o.banks.map((b) => new Bank(sampleRate, b.angles, b.resonators));
    this.openFraction = o.openFraction;
    this.combustionNoise = o.combustionNoise;
    // One four-stroke cycle spans two crankshaft revolutions.
    this.phase = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.running = false;
    };
  }

  process(_inputs, outputs, params) {
    if (!this.running) return false;

    const out = outputs[0][0];
    if (!out) return true;

    const rpsParam = params.rps;
    const throttle = params.throttle[0];
    const openFraction = this.openFraction;
    const noiseAmt = this.combustionNoise * (0.35 + throttle * 0.65);
    const inv = 1 / sampleRate;
    const load = 0.45 + throttle * 0.55;

    for (let i = 0; i < out.length; i++) {
      const rps = rpsParam.length > 1 ? rpsParam[i] : rpsParam[0];
      // Two revolutions per cycle, so the cycle advances at half crank speed.
      this.phase += rps * 0.5 * inv;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);

      // Pulses overlap more and more as revs rise, so the summed pressure
      // tends towards a constant and the DC blocker strips most of it away.
      // Left uncorrected the engine gets QUIETER towards the redline, which is
      // exactly backwards; scale the drive with crank speed to compensate.
      const rpsGain = Math.min(2.3, 0.5 + rps / 65);
      const drive = load * rpsGain;

      let sample = 0;
      for (let b = 0; b < this.banks.length; b++) {
        const bank = this.banks[b];
        let raw = bank.drive(this.phase, openFraction);
        // Combustion turbulence rides on top of the pressure pulse, so it is
        // gated by the pulse rather than added as constant hiss.
        raw += (Math.random() * 2 - 1) * raw * noiseAmt;
        sample += bank.process(raw * drive);
      }

      out[i] = sample / this.banks.length;
    }

    return true;
  }
}

registerProcessor('engine-processor', EngineProcessor);
