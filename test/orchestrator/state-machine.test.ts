import { describe, expect, it } from "vitest";
import {
  ALL_EVENTS,
  InvalidTransitionError,
  transition,
  VALID_TRANSITIONS,
  type OrchestratorEventType,
  type Phase,
} from "../../src/orchestrator/state-machine";

const PHASES: Phase[] = [
  "orientation",
  "hypothesis",
  "trace",
  "questioning",
  "feedback",
  "recap",
  "error",
];

function event(type: OrchestratorEventType): { type: OrchestratorEventType } {
  return { type };
}

describe("VALID_TRANSITIONS", () => {
  it("is the documented transition graph", () => {
    // Data-as-documentation: this locks the graph so a table edit is deliberate.
    expect(VALID_TRANSITIONS).toEqual({
      orientation: { repo_not_found: "error", candidates_found: "hypothesis" },
      hypothesis: { user_answered: "trace", user_skipped: "trace" },
      trace: {
        evidence_sufficient: "questioning",
        evidence_insufficient: "questioning",
      },
      questioning: {
        user_answered: "feedback",
        user_skipped: "feedback",
        turn_limit_reached: "recap",
      },
      feedback: {
        continue_probing: "questioning",
        chain_complete: "recap",
        turn_limit_reached: "recap",
      },
      recap: {},
      error: {},
    });
  });
});

describe("transition", () => {
  it("returns the target phase for every legal edge", () => {
    for (const phase of PHASES) {
      const edges = VALID_TRANSITIONS[phase];
      for (const [eventName, target] of Object.entries(edges)) {
        expect(
          transition(phase, event(eventName as OrchestratorEventType)),
          `${eventName} from ${phase}`,
        ).toBe(target);
      }
    }
  });

  it("throws InvalidTransitionError for every illegal edge", () => {
    for (const phase of PHASES) {
      const legal = new Set(Object.keys(VALID_TRANSITIONS[phase]));
      for (const eventName of ALL_EVENTS) {
        if (legal.has(eventName)) {
          continue;
        }
        expect(
          () => transition(phase, event(eventName)),
          `${eventName} from ${phase} must throw`,
        ).toThrow(InvalidTransitionError);
      }
    }
  });

  it("maps the key learning edges (readable assertions)", () => {
    expect(transition("orientation", event("candidates_found"))).toBe(
      "hypothesis",
    );
    expect(transition("orientation", event("repo_not_found"))).toBe("error");
    expect(transition("hypothesis", event("user_answered"))).toBe("trace");
    expect(transition("hypothesis", event("user_skipped"))).toBe("trace");
    expect(transition("trace", event("evidence_sufficient"))).toBe(
      "questioning",
    );
    expect(transition("trace", event("evidence_insufficient"))).toBe(
      "questioning",
    );
    expect(transition("questioning", event("user_answered"))).toBe("feedback");
    expect(transition("questioning", event("turn_limit_reached"))).toBe(
      "recap",
    );
    expect(transition("feedback", event("continue_probing"))).toBe(
      "questioning",
    );
    expect(transition("feedback", event("chain_complete"))).toBe("recap");
  });

  it("rejects terminal phases with any event", () => {
    for (const eventName of ALL_EVENTS) {
      expect(() => transition("recap", event(eventName))).toThrow(
        InvalidTransitionError,
      );
      expect(() => transition("error", event(eventName))).toThrow(
        InvalidTransitionError,
      );
    }
  });
});
