/**
 * TalkingHead wrapper — local 3D avatar for Athena, mouth driven by her
 * actual Agora audio.
 *
 * Agora ConvoAI stays the source of truth for Athena's voice. This module
 * taps the agent's remote audio track (the same silent, zero-gain
 * ScriptProcessor the Anam path used), computes a per-chunk loudness level,
 * and writes it to the avatar's `jawOpen` realtime morph target. The tab
 * that hears her animates her, so sync is by construction — no hosted
 * renderer, no API keys, no quota.
 *
 * We deliberately never call speakText/streamStart: TalkingHead's own audio
 * graph is left untouched so her voice plays exactly once (via Agora).
 */

import { TalkingHead } from '@met4citizen/talkinghead';

export type AvatarStatus = 'idle' | 'connecting' | 'connected' | 'error';

const TAP_SAMPLE_RATE = 16000;
const AVATAR_URL = '/avatars/athena.glb';
// RMS→jaw calibration: speech RMS runs ~0.05–0.3; this maps it onto a
// visible 0–1 jaw opening. Tweak here if Athena mumbles or gapes.
const JAW_GAIN = 4;

export class AthenaAvatarSession {
  private head: TalkingHead | null = null;
  private track: MediaStreamTrack | null = null;
  private speaking = false;
  private destroyed = false;
  private tap: {
    ctx: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
  } | null = null;

  constructor(
    private container: HTMLElement,
    private onStatusChange: (status: AvatarStatus) => void,
  ) {}

  /** Load the avatar into the container. Safe to abandon via destroy(). */
  async mount(): Promise<void> {
    this.onStatusChange('connecting');
    try {
      const head = new TalkingHead(this.container, {
        lipsyncLang: 'en',
        lipsyncModules: ['en'],
        cameraView: 'head',
        cameraRotateEnable: false,
        avatarMood: 'neutral',
      });
      this.head = head;
      await head.showAvatar({ url: AVATAR_URL, lipsyncLang: 'en' });
      if (this.destroyed) {
        this.teardownHead();
        return;
      }
      this.onStatusChange('connected');
      this.syncTap();
    } catch (error) {
      // Any load failure (missing asset, no WebGL) just keeps the idle orb.
      console.warn('TalkingHead avatar unavailable, staying on idle orb:', error);
      this.teardownHead();
      if (!this.destroyed) this.onStatusChange('error');
    }
  }

  /** Athena's Agora audio track; null when she leaves or the track dies. */
  setAudioTrack(track: MediaStreamTrack | null): void {
    if (track === this.track) return;
    this.track = track;
    this.syncTap();
  }

  /** Agora's speaking state for Athena — gates when the jaw actually moves. */
  setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.syncTap();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTap();
    this.teardownHead();
  }

  private syncTap(): void {
    // Deliberately not gated on `speaking`: that flag comes from the same
    // volume poll whose threshold (0.06) Athena's quiet remote track sits
    // under, so gating on it starved the jaw for whole turns. An always-on
    // tap is fine — silence measures RMS≈0, which leaves the jaw closed.
    if (this.head && this.track) this.startTap();
    else this.stopTap();
  }

  private startTap(): void {
    if (this.tap || !this.track) return;
    try {
      const ctx = new AudioContext({ sampleRate: TAP_SAMPLE_RATE });
      const source = ctx.createMediaStreamSource(new MediaStream([this.track]));
      // ScriptProcessor needs no separate worklet file; 512 frames at 16 kHz
      // is a jaw update every ~32 ms — smooth enough to read as lip motion.
      const processor = ctx.createScriptProcessor(512, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        this.setJaw(Math.min(1, rms * JAW_GAIN));
      };
      source.connect(processor);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      processor.connect(silent);
      silent.connect(ctx.destination);
      void ctx.resume().catch(() => undefined);
      this.tap = { ctx, source, processor };
    } catch (error) {
      // Best-effort overlay: a failed tap just leaves the jaw still.
      console.warn('Avatar audio tap failed to start:', error);
    }
  }

  private stopTap(): void {
    this.setJaw(null);
    if (!this.tap) return;
    const { ctx, source, processor } = this.tap;
    this.tap = null;
    try {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
    } catch {
      // already torn down
    }
    void ctx.close().catch(() => undefined);
  }

  /** realtime:null releases the jaw back to the animation/baseline. */
  private setJaw(level: number | null): void {
    const mt = this.head?.mtAvatar?.jawOpen;
    if (!mt) return;
    mt.realtime = level;
    mt.needsUpdate = true;
  }

  private teardownHead(): void {
    const head = this.head;
    this.head = null;
    if (!head) return;
    try {
      head.dispose();
    } catch {
      // best-effort — the container is being unmounted either way
    }
  }
}
