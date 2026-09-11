/**
 * Comparison report schema for SkillLineage v0.1.
 */

export type Relation =
  | "identical_bundle"
  | "same_skill_md"
  | "same_instructions"
  | "variant"
  | "different";

export interface CompareReport {
  readonly schemaVersion: "0.1";
  readonly tool: {
    readonly name: "skilllineage";
    readonly version: string;
  };
  readonly relation: Relation;
  readonly similarity: {
    readonly instructions: number;
  };
  readonly identity: {
    readonly sameBundle: boolean;
    readonly sameSkillMd: boolean;
    readonly sameInstructions: boolean;
  };
  readonly files: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly modified: readonly string[];
    readonly unchanged: readonly string[];
  };
}
