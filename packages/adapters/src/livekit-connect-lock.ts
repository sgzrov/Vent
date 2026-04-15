/**
 * Process-level connect gate for @livekit/rtc-node Room instances.
 *
 * The LiveKit Node SDK uses a singleton FFI runtime (FfiClient backed by a
 * global Rust FfiServer) with a dedicated single-threaded tokio runtime
 * (`audio_runtime`, worker_threads=1) for ALL audio capture across every Room
 * in the process.
 *
 * When two rooms connect + publish tracks + start comfort noise simultaneously,
 * the shared audio_runtime bottlenecks and one room starves — the agent either
 * never receives audio (so it stays silent for 30s then times out) or the
 * caller's audio stream dies mid-sentence (empty transcript).
 *
 * Serialising only the *connect* phase (Room.connect → track publish → agent
 * ready) is sufficient: once both rooms are established, the steady-state audio
 * loops interleave fine on the single worker thread because each frame is a
 * tiny ~20ms async task.
 *
 * This lock is shared across all adapters that create LiveKit Room instances:
 * WebRtcAudioChannel, RetellAudioChannel, ElevenLabsAudioChannel.
 */

let _livekitConnectLock: Promise<void> = Promise.resolve();

/**
 * Run `fn` while holding the process-level LiveKit connect lock.
 * Only one LiveKit room connect sequence can run at a time.
 */
export function withLivekitConnectLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _livekitConnectLock;
  let releaseFn: () => void;
  _livekitConnectLock = new Promise<void>((resolve) => { releaseFn = resolve; });
  return prev.then(() => fn().finally(() => releaseFn!()));
}
