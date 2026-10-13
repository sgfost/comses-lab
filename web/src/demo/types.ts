import type { Draft, Project, SourceCommit, ProjectTemplate } from '../../../shared/contracts.ts';
export type Files = Record<string, string>;
export interface Version extends SourceCommit { files: Files }
export interface DemoProject { project: Project; versions: Version[]; draft: Draft | null }
export interface DemoSeed { projects: DemoProject[]; templates: (ProjectTemplate & { files: Files })[] }
export interface DemoState { version: 1; projects: DemoProject[]; requests: Record<string, string> }
