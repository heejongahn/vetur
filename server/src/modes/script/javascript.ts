import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import {
  SymbolInformation,
  SymbolKind,
  CompletionItem,
  Location,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Definition,
  TextEdit,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  CompletionItemKind,
  Hover,
  MarkedString,
  DocumentHighlight,
  DocumentHighlightKind,
  CompletionList,
  Position,
  FormattingOptions
} from 'vscode-languageserver-types';
import { LanguageMode } from '../languageModes';
import { VueDocumentRegions } from '../embeddedSupport';
import { getServiceHost } from './serviceHost';
import { findComponents, ComponentInfo } from './findComponents';
import { prettierify, prettierEslintify } from '../../utils/prettier';
import { getFileFsPath, getFilePath } from '../../utils/paths';

import Uri from 'vscode-uri';
import * as ts from 'typescript';
import * as _ from 'lodash';

import { nullMode, NULL_SIGNATURE, NULL_COMPLETION } from '../nullMode';

export interface ScriptMode extends LanguageMode {
  findComponents(document: TextDocument): ComponentInfo[];
}

export function getJavascriptMode(
  documentRegions: LanguageModelCache<VueDocumentRegions>,
  workspacePath: string | null | undefined
): ScriptMode {
  if (!workspacePath) {
    return { ...nullMode, findComponents: () => [] };
  }
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    const vueDocument = documentRegions.get(document);
    return vueDocument.getEmbeddedDocumentByType('script');
  });

  const serviceHost = getServiceHost(workspacePath, jsDocuments);
  const { updateCurrentTextDocument, getScriptDocByFsPath } = serviceHost;
  let config: any = {};

  return {
    getId() {
      return 'javascript';
    },
    configure(c) {
      config = c;
    },
    doValidation(doc: TextDocument): Diagnostic[] {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const diagnostics = [
        ...service.getSyntacticDiagnostics(fileFsPath),
        ...service.getSemanticDiagnostics(fileFsPath)
      ];

      return diagnostics.map(diag => {
        // syntactic/semantic diagnostic always has start and length
        // so we can safely cast diag to TextSpan
        return {
          range: convertRange(scriptDoc, diag as ts.TextSpan),
          severity: DiagnosticSeverity.Error,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
        };
      });
    },
    doComplete(doc: TextDocument, position: Position): CompletionList {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { isIncomplete: false, items: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const offset = scriptDoc.offsetAt(position);
      const completions = service.getCompletionsAtPosition(fileFsPath, offset, undefined);
      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      const entries = completions.entries.filter(entry => entry.name !== '__vueEditorBridge');
      return {
        isIncomplete: false,
        items: entries.map((entry, index) => {
          const range = entry.replacementSpan && convertRange(scriptDoc, entry.replacementSpan);
          return {
            uri: doc.uri,
            position,
            label: entry.name,
            sortText: entry.sortText + index,
            kind: convertKind(entry.kind),
            textEdit: range && TextEdit.replace(range, entry.name),
            data: {
              // data used for resolving item details (see 'doResolve')
              languageId: scriptDoc.languageId,
              uri: doc.uri,
              offset
            }
          };
        })
      };
    },
    doResolve(doc: TextDocument, item: CompletionItem): CompletionItem {
      const { service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return NULL_COMPLETION;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const details = service.getCompletionEntryDetails(fileFsPath, item.data.offset, item.label, undefined, undefined);
      if (details) {
        item.detail = ts.displayPartsToString(details.displayParts);
        item.documentation = ts.displayPartsToString(details.documentation);
        delete item.data;
      }
      return item;
    },
    doHover(doc: TextDocument, position: Position): Hover {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { contents: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const info = service.getQuickInfoAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (info) {
        const display = ts.displayPartsToString(info.displayParts);
        const doc = ts.displayPartsToString(info.documentation);
        const markedContents: MarkedString[] = [{ language: 'ts', value: display }];
        if (doc) {
          markedContents.unshift(doc, '\n');
        }
        return {
          range: convertRange(scriptDoc, info.textSpan),
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp(doc: TextDocument, position: Position): SignatureHelp {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return NULL_SIGNATURE;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const signHelp = service.getSignatureHelpItems(fileFsPath, scriptDoc.offsetAt(position));
      if (!signHelp) {
        return NULL_SIGNATURE;
      }
      const ret: SignatureHelp = {
        activeSignature: signHelp.selectedItemIndex,
        activeParameter: signHelp.argumentIndex,
        signatures: []
      };
      signHelp.items.forEach(item => {
        const signature: SignatureInformation = {
          label: '',
          documentation: undefined,
          parameters: []
        };

        signature.label += ts.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = ts.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label,
            documentation: ts.displayPartsToString(p.documentation)
          };
          signature.label += label;
          signature.parameters!.push(parameter);
          if (i < a.length - 1) {
            signature.label += ts.displayPartsToString(item.separatorDisplayParts);
          }
        });
        signature.label += ts.displayPartsToString(item.suffixDisplayParts);
        ret.signatures.push(signature);
      });
      return ret;
    },
    findDocumentHighlight(doc: TextDocument, position: Position): DocumentHighlight[] {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const occurrences = service.getOccurrencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (occurrences) {
        return occurrences.map(entry => {
          return {
            range: convertRange(scriptDoc, entry.textSpan),
            kind: <DocumentHighlightKind>(entry.isWriteAccess
              ? DocumentHighlightKind.Write
              : DocumentHighlightKind.Text)
          };
        });
      }
      return [];
    },
    findDocumentSymbols(doc: TextDocument): SymbolInformation[] {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const items = service.getNavigationBarItems(fileFsPath);
      if (items) {
        const result: SymbolInformation[] = [];
        const existing: { [k: string]: boolean } = {};
        const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
          const sig = item.text + item.kind + item.spans[0].start;
          if (item.kind !== 'script' && !existing[sig]) {
            const symbol: SymbolInformation = {
              name: item.text,
              kind: convertSymbolKind(item.kind),
              location: {
                uri: doc.uri,
                range: convertRange(scriptDoc, item.spans[0])
              },
              containerName: containerLabel
            };
            existing[sig] = true;
            result.push(symbol);
            containerLabel = item.text;
          }

          if (item.childItems && item.childItems.length > 0) {
            for (const child of item.childItems) {
              collectSymbols(child, containerLabel);
            }
          }
        };

        items.forEach(item => collectSymbols(item));
        return result;
      }
      return [];
    },
    findDefinition(doc: TextDocument, position: Position): Definition {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const definitions = service.getDefinitionAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (!definitions) {
        return [];
      }

      const definitionResults: Definition = [];
      const program = service.getProgram();
      definitions.forEach(d => {
        const sourceFile = program.getSourceFile(d.fileName);
        const definitionTargetDoc = TextDocument.create(d.fileName, 'vue', 0, sourceFile.getText());
        definitionResults.push({
          uri: Uri.file(d.fileName).toString(),
          range: convertRange(definitionTargetDoc, d.textSpan)
        });
      });
      return definitionResults;
    },
    findReferences(doc: TextDocument, position: Position): Location[] {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const references = service.getReferencesAtPosition(fileFsPath, scriptDoc.offsetAt(position));
      if (!references) {
        return [];
      }

      const referenceResults: Location[] = [];
      references.forEach(r => {
        const referenceTargetDoc = getScriptDocByFsPath(fileFsPath);
        if (referenceTargetDoc) {
          referenceResults.push({
            uri: Uri.file(r.fileName).toString(),
            range: convertRange(referenceTargetDoc, r.textSpan)
          });
        }
      });
      return referenceResults;
    },
    format(doc: TextDocument, range: Range, formatParams: FormattingOptions): TextEdit[] {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);

      const defaultFormatter =
        scriptDoc.languageId === 'javascript'
          ? config.vetur.format.defaultFormatter.js
          : config.vetur.format.defaultFormatter.ts;

      if (defaultFormatter === 'none') {
        return [];
      }

      const needIndent = config.vetur.format.scriptInitialIndent;
      const parser = scriptDoc.languageId === 'javascript' ? 'babylon' : 'typescript';
      if (defaultFormatter === 'prettier') {
        const code = scriptDoc.getText();
        const filePath = getFileFsPath(scriptDoc.uri);
        if (config.prettier.eslintIntegration) {
          return prettierEslintify(code, filePath, range, needIndent, formatParams, config.prettier, parser);
        } else {
          return prettierify(code, filePath, range, needIndent, formatParams, config.prettier, parser);
        }
      } else {
        const initialIndentLevel = needIndent ? 1 : 0;
        const formatSettings: ts.FormatCodeSettings =
          scriptDoc.languageId === 'javascript' ? config.javascript.format : config.typescript.format;
        const convertedFormatSettings = convertOptions(formatSettings, formatParams, initialIndentLevel);

        const fileFsPath = getFileFsPath(doc.uri);
        const start = scriptDoc.offsetAt(range.start);
        const end = scriptDoc.offsetAt(range.end);
        const edits = service.getFormattingEditsForRange(fileFsPath, start, end, convertedFormatSettings);

        if (edits) {
          const result = [];
          for (const edit of edits) {
            if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
              result.push({
                range: convertRange(scriptDoc, edit.span),
                newText: edit.newText
              });
            }
          }
          return result;
        }
        return [];
      }
    },
    findComponents(doc: TextDocument) {
      const { service } = updateCurrentTextDocument(doc);
      const fileFsPath = getFileFsPath(doc.uri);
      return findComponents(service, fileFsPath);
    },
    onDocumentRemoved(document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    dispose() {
      serviceHost.getService().dispose();
      jsDocuments.dispose();
    }
  };
}

function languageServiceIncludesFile(ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram().getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange(document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertKind(kind: string): CompletionItemKind {
  switch (kind) {
    case 'primitive type':
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'var':
    case 'local var':
      return CompletionItemKind.Variable;
    case 'property':
    case 'getter':
    case 'setter':
      return CompletionItemKind.Field;
    case 'function':
    case 'method':
    case 'construct':
    case 'call':
    case 'index':
      return CompletionItemKind.Function;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'module':
      return CompletionItemKind.Module;
    case 'class':
      return CompletionItemKind.Class;
    case 'interface':
      return CompletionItemKind.Interface;
    case 'warning':
      return CompletionItemKind.File;
  }

  return CompletionItemKind.Property;
}

function convertSymbolKind(kind: string): SymbolKind {
  switch (kind) {
    case 'var':
    case 'local var':
    case 'const':
      return SymbolKind.Variable;
    case 'function':
    case 'local function':
      return SymbolKind.Function;
    case 'enum':
      return SymbolKind.Enum;
    case 'module':
      return SymbolKind.Module;
    case 'class':
      return SymbolKind.Class;
    case 'interface':
      return SymbolKind.Interface;
    case 'method':
      return SymbolKind.Method;
    case 'property':
    case 'getter':
    case 'setter':
      return SymbolKind.Property;
  }
  return SymbolKind.Variable;
}

function convertOptions(
  formatSettings: ts.FormatCodeSettings,
  options: FormattingOptions,
  initialIndentLevel: number
): ts.FormatCodeSettings {
  return _.assign(formatSettings, {
    convertTabsToSpaces: options.insertSpaces,
    tabSize: options.tabSize,
    indentSize: options.tabSize,
    baseIndentSize: options.tabSize * initialIndentLevel
  });
}
