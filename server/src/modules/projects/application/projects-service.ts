// Projects application service — the read-only machine-local projects listing
// (foundation; no registry CRUD, no speculative queries).
export interface ProjectsServiceOptions {
  /** Root of the machine-local projects workspace (config.projectsDir). */
  readonly rootDir: string;
  /** Injected fs port (infrastructure owns readdir; tests inject fakes). */
  readonly reader: (dir: string) => Promise<string[]>;
}

export class ProjectsService {
  readonly #rootDir: string;
  readonly #reader: (dir: string) => Promise<string[]>;

  constructor(opts: ProjectsServiceOptions) {
    this.#rootDir = opts.rootDir;
    this.#reader = opts.reader;
  }

  /** Subdirectories of the projects workspace; dot-entries and files excluded. */
  async listLocalProjects(): Promise<string[]> {
    return this.#reader(this.#rootDir);
  }
}
