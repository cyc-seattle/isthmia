import { AddTaskArgs, Project, TodoistApi } from "@doist/todoist-api-typescript";
import winston from "winston";

export class TodoistClient {
  private api!: TodoistApi;
  private projectCache!: Map<string, Project>;

  public async initialize(token: string) {
    this.api = new TodoistApi(token);
    await this.refreshProjectCache();
  }

  protected async refreshProjectCache() {
    winston.debug("Loading project cache");
    const projects = await this.api.getProjects();
    this.projectCache = new Map();

    for(const project of projects) {
      this.projectCache.set(project.name, project);
    }

    winston.debug("Loaded project cache", {cache: this.projectCache});
  }

  public getProject(name: string): Project | undefined {
    return this.projectCache.get(name);
  }

  public async getOrAddProject(parent: Project, name: string, color: string): Promise<Project | undefined> {
    const existing = this.getProject(name);
    if(existing) {
      winston.debug("Project exists", {existing});
      return existing;
    }

    winston.info("Creating project", {parent, name, color});
    return await this.api.addProject({
      name,
      parentId: parent.id,
      color
    });
  }

  public async addTask(args: AddTaskArgs) {
    winston.info("Creating task", args);
    return await await this.api.addTask(args);
  }
}
