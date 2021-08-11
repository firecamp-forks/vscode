/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable, DisposableStore, IDisposable, IReference, MutableDisposable } from 'vs/base/common/lifecycle';
import { Range } from 'vs/editor/common/core/range';
import { IModelDecoration } from 'vs/editor/common/model';
import { DenseKeyProvider } from 'vs/editor/common/model/bracketPairColorizer/smallImmutableSet';
import { DecorationProvider } from 'vs/editor/common/model/decorationProvider';
import { TextModel } from 'vs/editor/common/model/textModel';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { LanguageId } from 'vs/editor/common/modes';
import { LanguageConfigurationRegistry } from 'vs/editor/common/modes/languageConfigurationRegistry';
import {
	editorBracketHighlightingForeground1, editorBracketHighlightingForeground2, editorBracketHighlightingForeground3
} from 'vs/editor/common/view/editorColorRegistry';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { AstNode, AstNodeKind } from './ast';
import { TextEditInfo } from './beforeEditPositionMapper';
import { LanguageAgnosticBracketTokens } from './brackets';
import { Length, lengthAdd, lengthGreaterThanEqual, lengthLessThanEqual, lengthOfString, lengthsToRange, lengthZero, positionToLength, toLength } from './length';
import { parseDocument } from './parser';
import { FastTokenizer, TextBufferTokenizer } from './tokenizer';

export class BracketPairColorizer extends Disposable implements DecorationProvider {
	private readonly didChangeDecorationsEmitter = new Emitter<void>();
	// All views for a single text model currently share the same config.
	private config: NormalizedBracketPairColorizerConfig = NormalizedBracketPairColorizerConfig.default();
	private readonly cache = this._register(new MutableDisposable<IReference<BracketPairColorizerImpl>>());
	private readonly enabledOwnsers = new Set<number>();

	constructor(private readonly textModel: TextModel) {
		super();

		this._register(LanguageConfigurationRegistry.onDidChange((e) => {
			if (this.cache.value?.object.usesLanguageId(e.languageIdentifier.id)) {
				this.updateCache();
			}
		}));
	}

	configureBracketPairColorization(owner: number, config: BracketPairColorizerConfig | 'disabled'): void {
		if (config !== 'disabled') {
			const newConfig = NormalizedBracketPairColorizerConfig.from(config);
			if (JSON.stringify(newConfig) !== JSON.stringify(this.config)) {
				this.config = newConfig;
				this.cache.clear();
			}
			this.enabledOwnsers.add(owner);
		} else {
			this.enabledOwnsers.delete(owner);
			// don't clear the cache, so that reopen is fast.
			// The cache will be disposed with the text model!
		}

		if (!this.cache.value) {
			this.updateCache();
		}

		this.didChangeDecorationsEmitter.fire();
	}

	private updateCache() {
		if (this.enabledOwnsers.size > 0) {
			const store = new DisposableStore();
			this.cache.value = createDisposableRef(store.add(new BracketPairColorizerImpl(this.textModel, this.config)), store);
			store.add(this.cache.value.object.onDidChangeDecorations(e => this.didChangeDecorationsEmitter.fire(e)));
		}
	}

	handleContentChanged(change: IModelContentChangedEvent) {
		this.cache.value?.object.handleContentChanged(change);
	}

	getDecorationsInRange(range: Range, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		if (ownerId === undefined) {
			return [];
		}
		if (!this.enabledOwnsers.has(ownerId)) {
			return [];
		}
		return this.cache.value!.object.getDecorationsInRange(range, ownerId, filterOutValidation);
	}

	getAllDecorations(ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		if (ownerId === undefined) {
			return [];
		}
		if (!this.enabledOwnsers.has(ownerId)) {
			return [];
		}
		return this.cache.value!.object.getAllDecorations(ownerId, filterOutValidation);
	}

	onDidChangeDecorations(listener: () => void): IDisposable {
		return this.didChangeDecorationsEmitter.event(listener);
	}
}

function createDisposableRef<T>(object: T, disposable?: IDisposable): IReference<T> {
	return {
		object,
		dispose: () => disposable?.dispose(),
	};
}

export interface BracketPairColorizerConfig {
	readonly customBracketPairs?: readonly [string, string][];
}

class NormalizedBracketPairColorizerConfig implements BracketPairColorizerConfig {
	public static default(): NormalizedBracketPairColorizerConfig {
		return new NormalizedBracketPairColorizerConfig([]);
	}

	public static from(config: BracketPairColorizerConfig): NormalizedBracketPairColorizerConfig {
		return new NormalizedBracketPairColorizerConfig(config.customBracketPairs || []);
	}

	constructor(
		public readonly customBracketPairs: readonly [string, string][]
	) { }
}

class BracketPairColorizerImpl extends Disposable implements DecorationProvider {
	private readonly didChangeDecorationsEmitter = new Emitter<void>();
	private readonly colorProvider = new ColorProvider();

	/*
		There are two trees:
		* The initial tree that has no token information and is used for performant initial bracket colorization.
		* The tree that used token information to detect bracket pairs.

		To prevent flickering, we only switch from the initial tree to tree with token information
		when tokenization completes.
		Since the text can be edited while background tokenization is in progress, we need to update both trees.
	*/
	private initialAstWithoutTokens: AstNode | undefined;
	private astWithTokens: AstNode | undefined;

	private readonly brackets = new LanguageAgnosticBracketTokens(this.config.customBracketPairs);
	private readonly denseKeyProvider = new DenseKeyProvider<number>();

	public usesLanguageId(languageId: LanguageId): boolean {
		return this.brackets.usesLanguageId(languageId);
	}

	constructor(private readonly textModel: TextModel, private readonly config: NormalizedBracketPairColorizerConfig) {
		super();

		this._register(textModel.onDidChangeTokens(({ ranges, backgroundTokenizationCompleted }) => {
			if (backgroundTokenizationCompleted) {
				this.initialAstWithoutTokens = undefined;
			}

			const edits = ranges.map(r =>
				new TextEditInfo(
					toLength(r.fromLineNumber - 1, 0),
					toLength(r.toLineNumber, 0),
					toLength(r.toLineNumber - r.fromLineNumber + 1, 0)
				)
			);
			this.astWithTokens = this.parseDocumentFromTextBuffer(edits, this.astWithTokens);
			if (!this.initialAstWithoutTokens) {
				this.didChangeDecorationsEmitter.fire();
			}
		}));

		const brackets = this.brackets.getSingleLanguageBracketTokens(this.textModel.getLanguageIdentifier().id);
		const tokenizer = new FastTokenizer(this.textModel.getValue(), brackets);
		this.initialAstWithoutTokens = parseDocument(tokenizer, [], undefined, this.denseKeyProvider);
		this.astWithTokens = this.initialAstWithoutTokens.clone();
	}

	handleContentChanged(change: IModelContentChangedEvent) {
		const edits = change.changes.map(c => {
			const range = Range.lift(c.range);
			return new TextEditInfo(
				positionToLength(range.getStartPosition()),
				positionToLength(range.getEndPosition()),
				lengthOfString(c.text)
			);
		}).reverse();

		this.astWithTokens = this.parseDocumentFromTextBuffer(edits, this.astWithTokens);
		if (this.initialAstWithoutTokens) {
			this.initialAstWithoutTokens = this.parseDocumentFromTextBuffer(edits, this.initialAstWithoutTokens);
		}
	}

	/**
	 * @pure (only if isPure = true)
	*/
	private parseDocumentFromTextBuffer(edits: TextEditInfo[], previousAst: AstNode | undefined): AstNode {
		// Is much faster if `isPure = false`.
		const isPure = false;
		const previousAstClone = isPure ? previousAst?.clone() : previousAst;
		const tokenizer = new TextBufferTokenizer(this.textModel, this.brackets);
		const result = parseDocument(tokenizer, edits, previousAstClone, this.denseKeyProvider);
		return result;
	}

	getBracketsInRange(range: Range): BracketInfo[] {
		const startOffset = toLength(range.startLineNumber - 1, range.startColumn - 1);
		const endOffset = toLength(range.endLineNumber - 1, range.endColumn - 1);
		const result = new Array<BracketInfo>();
		const node = this.initialAstWithoutTokens || this.astWithTokens!;
		collectBrackets(node, lengthZero, node.length, startOffset, endOffset, result);
		return result;
	}

	getDecorationsInRange(range: Range, ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		const result = new Array<IModelDecoration>();
		const bracketsInRange = this.getBracketsInRange(range);
		for (const bracket of bracketsInRange) {
			result.push({
				id: `bracket${bracket.hash()}`,
				options: { description: 'BracketPairColorization', inlineClassName: this.colorProvider.getInlineClassName(bracket) },
				ownerId: 0,
				range: bracket.range
			});
		}
		return result;
	}
	getAllDecorations(ownerId?: number, filterOutValidation?: boolean): IModelDecoration[] {
		return this.getDecorationsInRange(new Range(1, 1, this.textModel.getLineCount(), 1), ownerId, filterOutValidation);
	}

	readonly onDidChangeDecorations = this.didChangeDecorationsEmitter.event;
}

function collectBrackets(node: AstNode, nodeOffsetStart: Length, nodeOffsetEnd: Length, startOffset: Length, endOffset: Length, result: BracketInfo[], level: number = 0): void {
	if (node.kind === AstNodeKind.Bracket) {
		const range = lengthsToRange(nodeOffsetStart, nodeOffsetEnd);
		result.push(new BracketInfo(range, level - 1));
	}
	else {
		if (node.kind === AstNodeKind.Pair) {
			level++;
		}
		for (const child of node.children) {
			nodeOffsetEnd = lengthAdd(nodeOffsetStart, child.length);
			if (lengthLessThanEqual(nodeOffsetStart, endOffset) && lengthGreaterThanEqual(nodeOffsetEnd, startOffset)) {
				collectBrackets(child, nodeOffsetStart, nodeOffsetEnd, startOffset, endOffset, result, level);
			}
			nodeOffsetStart = nodeOffsetEnd;
		}
	}
}

export class BracketInfo {
	constructor(
		public readonly range: Range,
		/** 0-based level */
		public readonly level: number
	) { }

	hash(): string {
		return `${this.range.toString()}-${this.level}`;
	}
}

class ColorProvider {
	getInlineClassName(bracket: BracketInfo): string {
		return `bracket-highlighting-${(bracket.level) % 3}`;
	}
}

registerThemingParticipant((theme, collector) => {
	// TODO support a dynamic amount of colors.
	const colors = [editorBracketHighlightingForeground1, editorBracketHighlightingForeground2, editorBracketHighlightingForeground3];

	let idx = 0;
	for (const color of colors) {
		const bracketMatchBackground = theme.getColor(color);
		if (bracketMatchBackground) {
			collector.addRule(`.monaco-editor .bracket-highlighting-${idx} { color: ${bracketMatchBackground}; }`);
		}
		idx++;
	}
});