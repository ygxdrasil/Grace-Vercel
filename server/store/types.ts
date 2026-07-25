/**
 * Raw key/value persistence. Encryption and JSON live a layer above, so a
 * backend only has to move strings around.
 */
export interface Backend {
  readonly name: string;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  /** Moves unreadable data aside rather than destroying it. */
  quarantine(key: string, value: string): Promise<void>;
}
