// TalkingHead ships no TypeScript definitions; this declares only the
// surface we use. See node_modules/@met4citizen/talkinghead/README.md.
declare module '@met4citizen/talkinghead' {
  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>);
    /** Morph-target state map; `realtime` overrides animation, `null` releases. */
    mtAvatar: Record<string, {
      realtime: number | null;
      needsUpdate: boolean;
      value?: number;
      applied?: number;
    }>;
    showAvatar(avatar: { url: string; [key: string]: unknown }): Promise<void>;
    dispose(): void;
  }
}
