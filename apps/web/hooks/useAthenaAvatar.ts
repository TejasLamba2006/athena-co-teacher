'use client';

import { useEffect, useRef, useState } from 'react';
import { AthenaAvatarSession, type AvatarStatus } from '@/lib/athena-avatar';

/**
 * Mounts Athena's TalkingHead avatar once she's present and feeds it her
 * actual Agora audio track, so the jaw moves to the words she speaks.
 *
 * `status` stays 'error' (caller keeps the idle orb) whenever the avatar
 * fails to load — missing asset, no WebGL. This hook never throws.
 */
export function useAthenaAvatar(
  enabled: boolean,
  speaking: boolean,
  agentTrack: MediaStreamTrack | null,
): { status: AvatarStatus; containerRef: React.RefObject<HTMLDivElement | null> } {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<AvatarStatus>('idle');
  const sessionRef = useRef<AthenaAvatarSession | null>(null);
  // Track/speaking often arrive before the avatar mounts (she's already
  // publishing when the grid renders). Refs let the mount effect replay the
  // current values so a session created late isn't born deaf.
  const trackRef = useRef(agentTrack);
  trackRef.current = agentTrack;
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    if (!enabled || !containerRef.current) {
      sessionRef.current?.destroy();
      sessionRef.current = null;
      setStatus('idle');
      return;
    }

    const session = new AthenaAvatarSession(containerRef.current, setStatus);
    sessionRef.current = session;
    session.setAudioTrack(trackRef.current);
    session.setSpeaking(speakingRef.current);
    void session.mount();

    return () => {
      session.destroy();
      sessionRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    sessionRef.current?.setAudioTrack(agentTrack);
  }, [agentTrack]);

  useEffect(() => {
    sessionRef.current?.setSpeaking(speaking);
  }, [speaking]);

  return { status, containerRef };
}
