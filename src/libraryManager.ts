/*
   Copyright 2025 Bernhard Walter
  
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

import * as fs from "fs";
import * as os from "os";
import * as process from "process";
import * as path from "path";
import * as vscode from "vscode";
import { version as ocp_vscode_version } from "./version";
import * as output from "./output";
import { getPythonPath, getEditor } from "./utils";
import { execute } from "./system/shell";
import { StatusManagerProvider } from "./statusManager";
import { TerminalExecute } from "./system/terminal";

function sanitize(lib: string) {
    return lib.replace("-", "_");
}

interface Package {
    name: string;
    version: string;
    location: string;
    installer: string;
    editable_project_location?: string;
}

function parsePackageData(
    jsonString: string
): Map<string, Omit<Package, "name">> {
    // Parse JSON and type assert to Package array
    const packages = JSON.parse(jsonString) as Package[];

    // Use existing mapping logic with enhanced type checking
    return new Map(
        packages.map((pkg) => {
            const { name, ...rest } = pkg;
            return [name, rest];
        })
    );
}

export async function pipList(
    python: string
): Promise<Map<string, Omit<Package, "name">>> {
    try {
        let result = execute(`${python} -m pip list -v --format json`, false);
        return parsePackageData(result);
    } catch (error: any) {
        output.error(error.stderr.toString());
        return new Map<string, Omit<Package, "name">>();
    }
}

export function isPythonVersion(python: string, version: string) {
    try {
        let result = execute(`${python} --version`);
        return result.split(" ")[1].startsWith(version);
    } catch (error) {
        return false;
    }
}

export async function installLib(
    libraryManager: LibraryManagerProvider,
    library: string = "",
    cmds: string[] = [],
    requiredPythonVersion: string = "",
    callback: CallableFunction = () => null
) {
    let commands: string[] = await libraryManager.getInstallLibCmds(
        library,
        cmds
    );
    if (commands.length === 0) {
        return;
    }
    let python = await getPythonPath();
    let reply =
        (await vscode.window.showQuickPick(["yes", "no"], {
            placeHolder: `Is "${python}" the right interpreter for the installation?`
        })) || "";
    if (reply === "" || reply === "no") {
        return;
    }

    python = await getPythonPath();

    if (python === "python") {
        vscode.window.showErrorMessage("Select Python Interpreter first!");
        return;
    }

    if (requiredPythonVersion !== "") {
        var valid = false;
        requiredPythonVersion.split(",").forEach((version) => {
            if (!valid) {
                valid = isPythonVersion(python, version);
            }
        });
        if (!valid) {
            vscode.window.showErrorMessage(
                `Python version(s) ${requiredPythonVersion} required!`
            );
            return;
        }
    }

    let term = vscode.window.createTerminal(
        "Library Installations",
        os.platform() === "win32" ? process.env.COMSPEC : undefined
    );
    term.show();
    const delay = vscode.workspace.getConfiguration("OcpCadViewer.advanced")[
        "terminalDelay"
    ];
    let listener = vscode.window.onDidCloseTerminal((e) => {
        libraryManager.refresh();

        if (["cadquery", "build123d"].includes(library)) {
            vscode.window.showInformationMessage(
                `Depending on your os, the first import of ${library} can take several seconds`
            );
        }

        callback();
        listener.dispose();
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    commands.push("exit");
    const command = commands.join(" && ");
    term.sendText(command, true);
}

export class LibraryManagerProvider
    implements vscode.TreeDataProvider<Library>
{
    statusManager: StatusManagerProvider;
    installCommands: any = {};
    exampleDownloads: any = {};
    codeSnippets: any = {};
    installed: Record<string, string[]> = {};
    terminal: TerminalExecute | undefined;

    constructor(statusManger: StatusManagerProvider) {
        this.statusManager = statusManger;
        this.readConfig();
    }

    readConfig() {
        this.installCommands = vscode.workspace.getConfiguration(
            "OcpCadViewer.advanced"
        )["installCommands"];
        let outdated = false;
        for (var lib of Object.keys(this.installCommands)) {
            if (!Array.isArray(this.installCommands[lib])) {
                outdated = true;
                break;
            }
        }
        if (outdated) {
            vscode.window.showErrorMessage(
                "Your installCommands are outdated.\nPlease update them in your settings.json ('OcpCadViewer.advanced.installCommands')"
            );
        }
        this.codeSnippets = vscode.workspace.getConfiguration(
            "OcpCadViewer.advanced"
        )["codeSnippets"];
        this.exampleDownloads = vscode.workspace.getConfiguration(
            "OcpCadViewer.advanced"
        )["exampleDownloads"];
    }

    private _onDidChangeTreeData: vscode.EventEmitter<
        Library | undefined | null | void
    > = new vscode.EventEmitter<Library | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<
        Library | undefined | null | void
    > = this._onDidChangeTreeData.event;

    async refresh(pythonPath: string | undefined = undefined) {
        this.readConfig();
        if (pythonPath == null) {
            pythonPath = await getPythonPath();
        }
        await this.findInstalledLibraries(pythonPath);
        this._onDidChangeTreeData.fire();
    }

    getInstallLibs() {
        return Object.keys(this.installCommands).sort();
    }

    async getInstallLibCmds(lib: string, cmds: string[] = []) {
        let commands: string[] = [];
        if (cmds.length === 0) {
            commands = this.installCommands[lib];
        } else {
            commands = cmds;
        }
        if (!Array.isArray(commands)) {
            vscode.window.showErrorMessage(
                "Your installCommands are outdated.\nPlease update them in your settings.json ('OcpCadViewer.advanced.installCommands')"
            );
            return [];
        }
        let python = await getPythonPath();
        let substCmds: string[] = [];
        commands.forEach((command: string) => {
            command = command.replace(
                "{ocp_vscode_version}",
                ocp_vscode_version
            );
            command = command.replace("{python}", '"' + python + '"');

            if (command.indexOf("{unset_conda}") >= 0) {
                command = command.replace("{unset_conda}", "");

                if (process.platform === "win32") {
                    let tempPath = process.env["TEMP"] || ".";
                    let code = "set CONDA_PREFIX=\n";
                    code = code + command;
                    command = path.join(tempPath, "__inst_with_pip__.cmd");
                    fs.writeFileSync(command, code);
                    output.info(`created batch file ${command} with commands:`);
                    output.info("\n" + code);
                } else {
                    command = "env -u CONDA_PREFIX " + command;
                }
                substCmds.push(command);
            } else {
                substCmds.push(command);
            }
        });
        return substCmds;
    }

    async findInstalledLibraries(pythonPath: string | undefined) {
        let installLibs = this.getInstallLibs();
        let python: string;
        if (pythonPath === undefined) {
            python = await getPythonPath();
        } else {
            python = pythonPath;
        }

        this.installed = {};

        try {
            var libs = await pipList(python);
            for (var [name, lib] of libs) {
                name = sanitize(name);
                if (installLibs.includes(name)) {
                    this.installed[name] = [
                        lib["version"],
                        lib["installer"],
                        lib["location"],
                        lib["editable_project_location"] || ""
                    ];
                }
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(error.message);
        }
    }

    getImportLibs() {
        return Object.keys(this.codeSnippets);
    }

    getImportLibCmds(lib: string) {
        return this.codeSnippets[lib];
    }

    pasteImport(library: string) {
        const editor = getEditor();
        if (editor !== undefined) {
            if (
                library === "ocp_vscode" &&
                this.statusManager.getPort() === ""
            ) {
                vscode.window.showErrorMessage("OCP CAD Viewer not running");
            } else {
                let importCmd = Object.assign([], this.codeSnippets[library]);
                if (library === "ocp_vscode") {
                    importCmd.push(`set_port(${this.statusManager.getPort()})`);
                }
                let snippet = new vscode.SnippetString(
                    importCmd.join("\n") + "\n"
                );
                editor?.insertSnippet(snippet);
            }
        } else {
            vscode.window.showErrorMessage("No editor open");
        }
    }

    getTreeItem(element: Library): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Library): Thenable<Library[]> {
        if (element) {
            if (Object.keys(this.installed).includes(element.label)) {
                let editable = this.installed[element.label][3];
                let manager = this.installed[element.label][1] || "n/a";
                let location = this.installed[element.label][2];
                let p = location.split(path.sep);
                let env = editable ? editable : p[p.length - 4];

                let libs: Library[] = [];
                libs.push(
                    new Library(
                        "installer",
                        { installer: manager },
                        vscode.TreeItemCollapsibleState.None
                    )
                );
                libs.push(
                    new Library(
                        "environment",
                        { location: location, env: env },
                        vscode.TreeItemCollapsibleState.None
                    )
                );
                libs.push(
                    new Library(
                        "editable",
                        { editable: (editable !== "").toString() },
                        vscode.TreeItemCollapsibleState.None
                    )
                );
                if (this.exampleDownloads[element.label]) {
                    libs.push(
                        new Library(
                            "examples",
                            { examples: "", parent: element.label },
                            vscode.TreeItemCollapsibleState.None
                        )
                    );
                }
                return Promise.resolve(libs);
            } else {
                return Promise.resolve([]);
            }
        } else {
            let libs: Library[] = [];
            this.getInstallLibs().forEach((lib: string) => {
                let installed = Object.keys(this.installed).includes(lib);

                let version = installed
                    ? this.installed[sanitize(lib)][0]
                    : "n/a";

                let state = installed
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.None;

                libs.push(new Library(lib, { version: version }, state));

                if (lib === "ocp_vscode") {
                    this.statusManager.installed = version !== "n/a";
                    this.statusManager.setLibraries(
                        Object.keys(this.installed)
                    );
                    this.statusManager.refresh(this.statusManager.getPort());
                }
            });

            return Promise.resolve(libs);
        }
    }
}

export class Library extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        private options: Record<string, string>,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);

        if (options.version !== undefined) {
            this.tooltip = `${this.label}-${options.version}`;
            this.description = options.version;
            this.contextValue = "library";
        } else if (options.installer !== undefined) {
            this.tooltip = options.installer;
            this.description = options.installer;
        } else if (options.location !== undefined) {
            this.tooltip = options.location;
            this.description = options.env;
        } else if (options.editable !== undefined) {
            this.tooltip = options.editable ? "editable" : "non-editable";
            this.description = options.editable.toString();
        } else if (options.examples !== undefined) {
            this.tooltip = "Download examples from github";
            this.description = "(download only)";
            this.contextValue = "examples";
        }
    }
    getParent() {
        return this.options.parent;
    }
}

export function createLibraryManager(statusManager: StatusManagerProvider) {
    const libraryManager = new LibraryManagerProvider(statusManager);
    vscode.window.registerTreeDataProvider("ocpCadSetup", libraryManager);
    vscode.window.createTreeView("ocpCadSetup", {
        treeDataProvider: libraryManager
    });

    output.info("Successfully registered CadqueryViewer Library Manager");

    return libraryManager;
}
