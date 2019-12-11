/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as nls from 'vscode-nls';
import { QuickPickItem, window, Disposable, QuickInputButton, QuickInput, QuickInputButtons } from 'vscode';

const localize = nls.loadMessageBundle();

/**
 * A multi-step input for creating new files using template.
 * This first part uses the helper class `MultiStepInput` that wraps the API for the multi-step case.
 */
export async function promptAndSave(folderName: string) {
	const serverObjects: QuickPickItem[] = ['Table', 'Stored Procedure']
		.map(label => ({ label }));

	interface State {
		title: string;
		step: number;
		totalSteps: number;
		objectType: QuickPickItem;
		name: string;
	}

	async function collectInputs() {
		const state = {} as Partial<State>;
		await MultiStepInput.run(input => pickServerObject(input, state));
		return state as State;
	}

	const title = localize('extension.createObjectTitle', 'Create Server Object');

	async function pickServerObject(input: MultiStepInput, state: Partial<State>) {
		state.objectType = await input.showQuickPick({
			title,
			step: 1,
			totalSteps: 3,
			placeholder: localize('extension.selectObjectType', 'Select an object type'),
			items: serverObjects,
			activeItem: state.objectType
		});
		return (input: MultiStepInput) => inputName(input, state);
	}

	async function inputName(input: MultiStepInput, state: Partial<State>) {
		state.name = await input.showInputBox({
			title,
			step: 2,
			totalSteps: 2,
			value: state.name || 'new' + state.objectType.label,
			prompt: localize('extension.objectNamePrompt', 'Please enter object name'),
			validate: validateNameIsNotEmpty
		});
	}

	async function validateNameIsNotEmpty(name: string) {
		if (name) {
			var newfilepath = correctExtension(folderName + path.sep + name);
			if (fs.existsSync(newfilepath)) {
				return localize('extension.fileExists', "File already exists");
			}
			return undefined;
		}
		return localize('extension.objectNameEmpty', 'Name cannot be empty');
	}

	function correctExtension(filename) {
		if (path.extname(filename) !== '.sql') {
			filename = filename + '.sql';
		}
		return filename;
	}

	function openTemplateAndSaveNewFile(type: string, filepath: string) {
		let templatefileName = type + '.tmpl';
		vscode.workspace.openTextDocument(vscode.extensions.getExtension('Microsoft.azuredatastudio-postgresql').extensionPath + '/templates/' + templatefileName)
			.then((doc: vscode.TextDocument) => {
				let text = doc.getText();
				var filename = path.basename(filepath, path.extname(filepath));
				text = text.replace('${name}', filename);
				let cursorPosition = findCursorInTemlpate(text);
				text = text.replace('${cursor}', '');
				fs.writeFileSync(filepath, text);
				vscode.workspace.openTextDocument(filepath).then((doc) => {
					vscode.window.showTextDocument(doc).then((editor) => {
						let newselection = new vscode.Selection(cursorPosition, cursorPosition);
						editor.selection = newselection;
					});
				});
			});
	}

	function findCursorInTemlpate(text: string) {
		let cursorPos = text.indexOf('${cursor}');
		let preCursor = text.substr(0, cursorPos);
		let lineNum = preCursor.match(/\n/gi).length;
		let charNum = preCursor.substr(preCursor.lastIndexOf('\n')).length;
		return new vscode.Position(lineNum, charNum);
	}

    const state = await collectInputs();
	var newfilepath = folderName + path.sep + state.name;
	if (fs.existsSync(newfilepath)) {
		vscode.window.showErrorMessage(localize('extension.fileExists', "File already exists"));
		return;
	}
	newfilepath = correctExtension(newfilepath);
	openTemplateAndSaveNewFile(state.objectType.label, newfilepath);
}

// -------------------------------------------------------
// Helper code that wraps the API for the multi-step case.
// -------------------------------------------------------

class InputFlowAction {
	private constructor() { }
	static back = new InputFlowAction();
	static cancel = new InputFlowAction();
	static resume = new InputFlowAction();
}

type InputStep = (input: MultiStepInput) => Thenable<InputStep | void>;

interface QuickPickParameters<T extends QuickPickItem> {
	title: string;
	step: number;
	totalSteps: number;
	items: T[];
	activeItem?: T;
	placeholder: string;
	buttons?: QuickInputButton[];
}

interface InputBoxParameters {
	title: string;
	step: number;
	totalSteps: number;
	value: string;
	prompt: string;
	validate: (value: string) => Promise<string | undefined>;
	buttons?: QuickInputButton[];
}

class MultiStepInput {
	private current?: QuickInput;
	private steps: InputStep[] = [];

	static async run<T>(start: InputStep) {
		const input = new MultiStepInput();
		return input.stepThrough(start);
	}

	private async stepThrough<T>(start: InputStep) {
		let step: InputStep | void = start;
		while (step) {
			this.steps.push(step);
			if (this.current) {
				this.current.enabled = false;
				this.current.busy = true;
			}
			try {
				step = await step(this);
			} catch (err) {
				if (err === InputFlowAction.back) {
					this.steps.pop();
					step = this.steps.pop();
				} else if (err === InputFlowAction.resume) {
					step = this.steps.pop();
				} else if (err === InputFlowAction.cancel) {
					step = undefined;
				} else {
					throw err;
				}
			}
		}
		if (this.current) {
			this.current.dispose();
		}
	}

	async showQuickPick<T extends QuickPickItem, P extends QuickPickParameters<T>>({ title, step, totalSteps, items, activeItem, placeholder, buttons }: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<T | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createQuickPick<T>();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.placeholder = placeholder;
				input.items = items;
				if (activeItem) {
					input.activeItems = [activeItem];
				}
				input.buttons = [
					...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
					...(buttons || [])
				];
				disposables.push(
					input.onDidTriggerButton(item => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidChangeSelection(items => resolve(items[0])),
					input.onDidHide(() => {
						(async () => {
							reject(InputFlowAction.cancel);
						})()
							.catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}

	async showInputBox<P extends InputBoxParameters>({ title, step, totalSteps, value, prompt, validate, buttons }: P) {
		const disposables: Disposable[] = [];
		try {
			return await new Promise<string | (P extends { buttons: (infer I)[] } ? I : never)>((resolve, reject) => {
				const input = window.createInputBox();
				input.title = title;
				input.step = step;
				input.totalSteps = totalSteps;
				input.value = value || '';
				input.prompt = prompt;
				input.buttons = [
					...(this.steps.length > 1 ? [QuickInputButtons.Back] : []),
					...(buttons || [])
				];
				disposables.push(
					input.onDidTriggerButton(item => {
						if (item === QuickInputButtons.Back) {
							reject(InputFlowAction.back);
						} else {
							resolve(<any>item);
						}
					}),
					input.onDidAccept(async () => {
						const value = input.value;
						input.enabled = false;
						input.busy = true;
						let validationMessage = await validate(value);
						if (validationMessage) {
							input.validationMessage = validationMessage;
						} else {
							resolve(value);
						}
						input.enabled = true;
						input.busy = false;
					}),
					input.onDidHide(() => {
						(async () => {
							reject(InputFlowAction.cancel);
						})()
							.catch(reject);
					})
				);
				if (this.current) {
					this.current.dispose();
				}
				this.current = input;
				this.current.show();
			});
		} finally {
			disposables.forEach(d => d.dispose());
		}
	}
}