// DA5 provider interface (bridge side). Adding a provider needs no protocol change: implement this and
// register it in providers(). `secret()` is bridge-internal; its value only ever goes into a `secret`
// wire message for an in-flight auth.* command.
import type { AuthAccount, ProviderStatus } from "@tabagent/protocol";
import type { BridgeProviderName } from "./config";

export type SecretRequestField = "username" | "password" | "totp";

export interface BridgeProvider {
  readonly name: BridgeProviderName;
  /** State for auth.status / doctor. Never fetches a secret. `disabled` providers are left out of auth.status. */
  status(): Promise<ProviderStatus>;
  /**
   * Accounts whose saved URL is on the origin's registrable domain (DA3 floor; the extension narrows
   * further with itemMatches). Throws TabAgentError NOT_FOUND with a user-facing hint when not usable.
   */
  find(origin: string): Promise<AuthAccount[]>;
  /** The value for one field of one item (`localId` is the part after `provider:`). */
  secret(localId: string, field: SecretRequestField): Promise<string>;
  /** Kill switch / daemon exit: drop any held session (Bitwarden runs `bw lock`). */
  drop?(reason: string): Promise<void>;
  /** auth.login classified `next: "unknown"` with the form still present: the password may have changed. */
  noteLoginUnknown?(): void;
}
