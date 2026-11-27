import { describe, expect, it } from 'vitest';
import {
  computeDueDates,
  DEFAULT_SLA_POLICIES,
  isFirstResponseBreached,
  isResolutionBreached,
  slaIndicator,
  type SlaTicketState,
} from '../../src/server/domain/sla';

const t0 = new Date('2026-03-02T09:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

function ticket(overrides: Partial<SlaTicketState> = {}): SlaTicketState {
  return {
    status: 'open',
    firstResponseAt: null,
    resolvedAt: null,
    firstResponseDueAt: at(30),
    resolutionDueAt: at(240),
    ...overrides,
  };
}

describe('SLA rules', () => {
  it('computes due dates from the policy', () => {
    const due = computeDueDates(t0, DEFAULT_SLA_POLICIES.urgent);
    expect(due.firstResponseDueAt).toEqual(at(30));
    expect(due.resolutionDueAt).toEqual(at(240));
  });

  it('first response: breached only after the due time with no reply, or a late reply', () => {
    expect(isFirstResponseBreached(ticket(), at(29))).toBe(false);
    expect(isFirstResponseBreached(ticket(), at(30))).toBe(true);
    expect(isFirstResponseBreached(ticket({ firstResponseAt: at(10) }), at(999))).toBe(false);
    expect(isFirstResponseBreached(ticket({ firstResponseAt: at(31) }), at(999))).toBe(true);
  });

  it('resolution: resolved in time is met; reopened tickets keep counting', () => {
    expect(isResolutionBreached(ticket({ status: 'resolved', resolvedAt: at(100) }), at(999))).toBe(
      false,
    );
    expect(isResolutionBreached(ticket({ status: 'closed', resolvedAt: at(300) }), at(999))).toBe(
      true,
    );
    expect(isResolutionBreached(ticket({ status: 'open', resolvedAt: null }), at(241))).toBe(true);
    expect(isResolutionBreached(ticket({ status: 'pending' }), at(200))).toBe(false);
  });

  it('picks one indicator for the inbox badge', () => {
    expect(slaIndicator(ticket(), at(5))).toEqual({
      state: 'running',
      kind: 'first_response',
      dueAt: at(30),
    });
    expect(slaIndicator(ticket({ firstResponseAt: at(5) }), at(6))).toEqual({
      state: 'running',
      kind: 'resolution',
      dueAt: at(240),
    });
    expect(slaIndicator(ticket(), at(31))).toEqual({ state: 'breached', kind: 'first_response' });
    expect(
      slaIndicator(
        ticket({ firstResponseAt: at(5), status: 'resolved', resolvedAt: at(9) }),
        at(999),
      ),
    ).toEqual({
      state: 'met',
    });
  });
});
