import type { RealtimeBroker } from '../realtime/broker';

/** Collaborators injected into services, so tests can supply fakes and a fixed clock. */
export interface ServiceDeps {
  readonly broker: RealtimeBroker;
  readonly now: () => Date;
}
