// Copyright (c) 2015, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import _ from 'underscore';

import {isString} from '../../shared/common-utils.js';
import {
    AsmResultLabel,
    AsmResultSource,
    ParsedAsmResult,
    ParsedAsmResultLine,
} from '../../types/asmresult/asmresult.interfaces.js';
import {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import {assert, unwrap} from '../assert.js';
import {PropertyGetter} from '../properties.interfaces.js';
import * as utils from '../utils.js';

import {IAsmParser} from './asm-parser.interfaces.js';
import {AsmRegex} from './asmregex.js';

export type ParsingContext = {
    files: Record<number, string>;
    source: AsmResultSource | undefined | null;
    dontMaskFilenames: boolean;
    prevLabel: string;
    prevLabelIsUserFunction: boolean;
};

export class AsmParser extends AsmRegex implements IAsmParser {
    labelFindNonMips: RegExp;
    labelFindMips: RegExp;
    mipsLabelDefinition: RegExp;
    dataDefn: RegExp;
    fileFind: RegExp;
    hasOpcodeRe: RegExp;
    instructionRe: RegExp;
    identifierFindRe: RegExp;
    hasNvccOpcodeRe: RegExp;
    definesFunction: RegExp;
    definesGlobal: RegExp;
    definesWeak: RegExp;
    definesAlias: RegExp;
    indentedLabelDef: RegExp;
    assignmentDef: RegExp;
    directive: RegExp;
    startAppBlock: RegExp;
    endAppBlock: RegExp;
    startAsmNesting: RegExp;
    endAsmNesting: RegExp;
    cudaBeginDef: RegExp;
    cudaEndDef: RegExp;
    binaryHideFuncRe: RegExp | null;
    maxAsmLines: number;
    asmOpcodeRe: RegExp;
    relocationRe: RegExp;
    relocDataSymNameRe: RegExp;
    lineRe: RegExp;
    labelRe: RegExp;
    destRe: RegExp;
    commentRe: RegExp;
    instOpcodeRe: RegExp;
    commentOnly: RegExp;
    commentOnlyNvcc: RegExp;
    sourceTag: RegExp;
    sourceD2Tag: RegExp;
    sourceCVTag: RegExp;
    source6502Dbg: RegExp;
    source6502DbgEnd: RegExp;
    sourceStab: RegExp;
    stdInLooking: RegExp;
    endBlock: RegExp;
    blockComments: RegExp;

    constructor(compilerProps?: PropertyGetter) {
        super();

        this.labelFindNonMips = /[.A-Z_a-z][\w$.]*/g;
        // MIPS labels can start with a $ sign, but other assemblers use $ to mean literal.
        this.labelFindMips = /[$.A-Z_a-z][\w$.]*/g;
        this.mipsLabelDefinition = /^\$[\w$.]+:/;
        this.dataDefn =
            /^\s*\.(ascii|asciz|base64|[1248]?byte|dc(?:\.[abdlswx])?|dcb(?:\.[bdlswx])?|ds(?:\.[bdlpswx])?|double|dword|fill|float|half|hword|int|long|octa|quad|short|single|skip|space|string(?:8|16|32|64)?|value|word|xword|zero)/;
        this.fileFind = /^\s*\.(?:cv_)?file\s+(\d+)\s+"([^"]+)"(\s+"([^"]+)")?.*/;
        // Opcode expression here matches LLVM-style opcodes of the form `%blah = opcode`
        this.hasOpcodeRe = /^\s*(%[$.A-Z_a-z][\w$.]*\s*=\s*)?[A-Za-z]/;
        this.instructionRe = /^\s*[A-Za-z]+/;
        this.identifierFindRe = /([$.@A-Z_a-z]\w*)(?:@\w+)*/g;
        this.hasNvccOpcodeRe = /^\s*[@A-Za-z|]/;
        this.definesFunction = /^\s*\.(type.*,\s*[#%@]function|proc\s+[.A-Z_a-z][\w$.]*:.*)$/;
        this.definesGlobal = /^\s*\.(?:globa?l|GLB|export)\s*([.A-Z_a-z][\w$.]*)/;
        this.definesWeak = /^\s*\.(?:weakext|weak)\s*([.A-Z_a-z][\w$.]*)/;
        this.definesAlias = /^\s*\.set\s*([.A-Z_a-z][\w$.]*\s*),\s*\.\s*(\+\s*0)?$/;
        this.indentedLabelDef = /^\s*([$.A-Z_a-z][\w$.]*):/;
        this.assignmentDef = /^\s*([$.A-Z_a-z][\w$.]*)\s*=\s*(.*)/;
        this.directive = /^\s*\..*$/;
        // These four regexes when phrased as /\s*#APP.*/ etc exhibit costly polynomial backtracking. Instead use ^$ and
        // test with regex.test(line.trim()), more robust anyway
        this.startAppBlock = /^#APP.*$/;
        this.endAppBlock = /^#NO_APP.*$/;
        this.startAsmNesting = /^# Begin ASM.*$/;
        this.endAsmNesting = /^# End ASM.*$/;
        this.cudaBeginDef = /\.(entry|func)\s+(?:\([^)]*\)\s*)?([$.A-Z_a-z][\w$.]*)\($/;
        this.cudaEndDef = /^\s*\)\s*$/;

        this.binaryHideFuncRe = null;
        this.maxAsmLines = 5000;
        if (compilerProps) {
            const binaryHideFuncReValue = compilerProps('binaryHideFuncRe');
            if (binaryHideFuncReValue) {
                assert(isString(binaryHideFuncReValue));
                this.binaryHideFuncRe = new RegExp(binaryHideFuncReValue);
            }

            this.maxAsmLines = compilerProps('maxLinesOfAsm', this.maxAsmLines);
        }

        this.asmOpcodeRe = /^\s*(?<address>[\da-f]+):\s*(?<opcodes>([\da-f]{2} ?)+)\s*(?<disasm>.*)/;
        this.relocationRe = /^\s*(?<address>[\da-f]+):\s*(?<relocname>(R_[\dA-Z_]+))\s*(?<relocdata>.*)/;
        this.relocDataSymNameRe = /^(?<symname>[^\d-+][\w.]*)?\s*(?<addend_or_value>.*)$/;
        if (process.platform === 'win32') {
            this.lineRe = /^([A-Z]:\/[^:]+):(?<line>\d+).*/;
        } else {
            this.lineRe = /^(\/[^:]+):(?<line>\d+).*/;
        }

        // labelRe is made very greedy as it's also used with demangled objdump output (eg. it can have c++ template
        // with <>).
        this.labelRe = /^([\da-f]+)\s+<(.+)>:$/;
        this.destRe = /\s([\da-f]+)\s+<([^+>]+)(\+0x[\da-f]+)?>$/;
        this.commentRe = /[#;]/;
        this.instOpcodeRe = /(\.inst\.?\w?)\s*(.*)/;

        // Lines matching the following pattern are considered comments:
        // - starts with '#', '@', '//' or a single ';' (non repeated)
        // - starts with ';;' and the first non-whitespace before end of line is not #
        this.commentOnly = /^\s*(((#|@|\/\/).*)|(\/\*.*\*\/)|(;\s*)|(;[^;].*)|(;;\s*[^\s#].*))$/;
        this.commentOnlyNvcc = /^\s*(((#|;|\/\/).*)|(\/\*.*\*\/))$/;
        this.sourceTag = /^\s*\.loc\s+(\d+)\s+(\d+)\s+(.*)/;
        this.sourceD2Tag = /^\s*\.d2line\s+(\d+),?\s*(\d*).*/;
        this.sourceCVTag = /^\s*\.cv_loc\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+).*/;
        this.source6502Dbg = /^\s*\.dbg\s+line,\s*"([^"]+)",\s*(\d+)/;
        this.source6502DbgEnd = /^\s*\.dbg\s+line[^,]/;
        this.sourceStab = /^\s*\.stabn\s+(\d+),0,(\d+),.*/;
        this.stdInLooking = /<stdin>|^-$|example\.[^/]+$|<source>/;
        this.endBlock = /\.(cfi_endproc|data|text|section)/;
        this.blockComments = /^[\t ]*\/\*(\*(?!\/)|[^*])*\*\/\s*/gm;
    }

    checkVLIWpacket(_line: string, inVLIWpacket: boolean) {
        return inVLIWpacket;
    }

    hasOpcode(line: string, inNvccCode = false, _inVLIWpacket = false) {
        // Remove any leading label definition...
        const match = line.match(this.labelDef);
        if (match) {
            line = line.substring(match[0].length);
        }
        // Strip any comments
        line = line.split(this.commentRe, 1)[0];
        // .inst generates an opcode, so also counts
        if (this.instOpcodeRe.test(line)) return true;
        // Detect assignment, that's not an opcode...
        if (this.assignmentDef.test(line)) return false;
        if (inNvccCode) {
            return this.hasNvccOpcodeRe.test(line);
        }
        return this.hasOpcodeRe.test(line);
    }

    labelFindFor(asmLines: string[]) {
        const isMips = _.any(asmLines, line => this.mipsLabelDefinition.test(line));
        return isMips ? this.labelFindMips : this.labelFindNonMips;
    }

    findUsedLabels(asmLines: string[], filterDirectives?: boolean): Set<string> {
        const labelsUsed: Set<string> = new Set();
        const weakUsages: Map<string, Set<string>> = new Map();

        function markWeak(fromLabel: string, toLabel: string) {
            if (!weakUsages.has(fromLabel)) weakUsages.set(fromLabel, new Set());
            unwrap(weakUsages.get(fromLabel)).add(toLabel);
        }

        const labelFind = this.labelFindFor(asmLines);
        // The current label set is the set of labels all pointing at the current code, so:
        // foo:
        // bar:
        //    add r0, r0, #1
        // in this case [foo, bar] would be the label set for the add instruction.
        let currentLabelSet: string[] = [];
        let inLabelGroup = false;
        let inCustomAssembly = 0;
        const startBlock = /\.cfi_startproc/;
        const endBlock = /\.cfi_endproc/;
        let inFunction = false;
        let inNvccCode = false;
        let inVLIWpacket = false;
        let definingAlias: string | undefined;

        // Scan through looking for definite label usages (ones used by opcodes), and ones that are weakly used: that
        // is, their use is conditional on another label. For example:
        // .foo: .string "moo"
        // .baz: .quad .foo
        //       mov eax, .baz
        // In this case, the '.baz' is used by an opcode, and so is strongly used.
        // The '.foo' is weakly used by .baz.
        // Also, if we have random data definitions within a block of a function (between cfi_startproc and
        // cfi_endproc), we assume they are strong usages. This covers things like jump tables embedded in ARM code.
        // See https://github.com/compiler-explorer/compiler-explorer/issues/2788
        for (let line of asmLines) {
            if (this.startAppBlock.test(line.trim()) || this.startAsmNesting.test(line.trim())) {
                inCustomAssembly++;
            } else if (this.endAppBlock.test(line.trim()) || this.endAsmNesting.test(line.trim())) {
                inCustomAssembly--;
            } else if (startBlock.test(line)) {
                inFunction = true;
            } else if (endBlock.test(line)) {
                inFunction = false;
            } else if (this.cudaBeginDef.test(line)) {
                inNvccCode = true;
            } else {
                inVLIWpacket = this.checkVLIWpacket(line, inVLIWpacket);
            }

            if (inCustomAssembly > 0) line = this.fixLabelIndentation(line);

            let match = line.match(this.labelDef);
            if (match) {
                if (inLabelGroup) currentLabelSet.push(match[1]);
                else currentLabelSet = [match[1]];
                inLabelGroup = true;
                if (definingAlias) {
                    // If we're defining an alias, then any labels in this group are weakly used by the alias.
                    markWeak(definingAlias, match[1]);
                }
            } else {
                if (inLabelGroup) {
                    inLabelGroup = false;
                    // Once we exit the label group after an alias, we're no longer defining an alias.
                    definingAlias = undefined;
                }
            }
            match = line.match(this.definesGlobal);
            if (!match) match = line.match(this.definesWeak);
            if (!match) match = line.match(this.cudaBeginDef);
            if (match) labelsUsed.add(match[1]);

            const definesAlias = line.match(this.definesAlias);
            if (definesAlias) {
                // We are defining an alias for match[1]; so the next label definition is the _same_ as this.
                definingAlias = definesAlias[1];
            }

            const definesFunction = line.match(this.definesFunction);
            if (!definesFunction && (!line || line[0] === '.')) continue;

            match = line.match(labelFind);
            if (!match) continue;

            if (!filterDirectives || this.hasOpcode(line, inNvccCode, inVLIWpacket) || definesFunction) {
                // Only count a label as used if it's used by an opcode, or else we're not filtering directives.
                for (const label of match) labelsUsed.add(label);
            } else {
                // If we have a current label, then any subsequent opcode or data definition's labels are referred to
                // weakly by that label.
                const isDataDefinition = this.dataDefn.test(line);
                const isOpcode = this.hasOpcode(line, inNvccCode, inVLIWpacket);
                if (isDataDefinition || isOpcode) {
                    if (inFunction && isDataDefinition) {
                        // Data definitions in the middle of code should be treated as if they were used strongly.
                        for (const label of match) labelsUsed.add(label);
                    } else {
                        for (const currentLabel of currentLabelSet) {
                            for (const label of match) markWeak(currentLabel, label);
                        }
                    }
                }
            }
        }

        // Now follow the chains of used labels, marking any weak references they refer to as also used. We recursively
        // follow the newly-strong references along the path until we hit something that's already marked as used.
        const recurseMarkUsed = (label: string) => {
            labelsUsed.add(label);
            const usages = weakUsages.get(label);
            if (!usages) return;
            for (const nowUsed of usages) {
                if (!labelsUsed.has(nowUsed)) recurseMarkUsed(nowUsed);
            }
        };
        // Iterate over a copy of the initial used labels, as the set will be modified during iteration.
        for (const label of new Set(labelsUsed)) recurseMarkUsed(label);
        return labelsUsed;
    }

    parseFiles(asmLines: string[]) {
        const files: Record<number, string> = {};
        for (const line of asmLines) {
            const match = line.match(this.fileFind);
            if (match) {
                const lineNum = Number.parseInt(match[1]);
                if (match[4] && !line.includes('.cv_file')) {
                    // Clang-style file directive '.file X "dir" "filename"'
                    if (match[4].startsWith('/')) {
                        files[lineNum] = match[4];
                    } else {
                        files[lineNum] = match[2] + '/' + match[4];
                    }
                } else {
                    files[lineNum] = match[2];
                }
            }
        }
        return files;
    }

    // Remove labels which do not have a definition.
    removeLabelsWithoutDefinition(asm: ParsedAsmResultLine[], labelDefinitions: Record<string, number>) {
        for (const obj of asm) {
            if (obj.labels) {
                obj.labels = obj.labels.filter(label => labelDefinitions[label.target || label.name]);
            }
        }
    }

    // Get labels which are used in the given line.
    getUsedLabelsInLine(line: string): AsmResultLabel[] {
        const labelsInLine: AsmResultLabel[] = [];

        // Strip any comments
        const instruction = line.split(this.commentRe, 1)[0];

        // Remove the instruction.
        const params = instruction.replace(this.instructionRe, '');

        const removedCol = instruction.length - params.length + 1;
        params.replace(this.identifierFindRe, (symbol, target, index) => {
            const startCol = removedCol + index;
            const label: AsmResultLabel = {
                name: symbol,
                range: {
                    startCol: startCol,
                    endCol: startCol + symbol.length,
                },
            };
            if (target !== symbol) {
                label.target = target;
            }
            labelsInLine.push(label);
            return symbol;
        });

        return labelsInLine;
    }

    protected isUserFunctionByLookingAhead(context: ParsingContext, asmLines: string[], idxFrom: number): boolean {
        const funcContext: ParsingContext = {
            files: context.files,
            source: undefined,
            dontMaskFilenames: true,
            prevLabelIsUserFunction: false,
            prevLabel: '',
        };

        for (let idx = idxFrom; idx < asmLines.length; idx++) {
            const line = asmLines[idx];

            const endprocMatch = line.match(this.endBlock);
            if (endprocMatch) return false;

            this.handleSource(funcContext, line);
            this.handleStabs(funcContext, line);
            this.handle6502(funcContext, line);

            if (funcContext.source?.mainsource) return true;
        }

        return false;
    }

    protected handleSource(context: ParsingContext, line: string) {
        let match = line.match(this.sourceTag);
        if (match) {
            const file = utils.maskRootdir(context.files[Number.parseInt(match[1])]);
            const sourceLine = Number.parseInt(match[2]);
            if (file) {
                if (context.dontMaskFilenames) {
                    context.source = {
                        file: file,
                        line: sourceLine,
                        mainsource: this.stdInLooking.test(file),
                    };
                } else {
                    context.source = {
                        file: this.stdInLooking.test(file) ? null : file,
                        line: sourceLine,
                    };
                }
                const sourceCol = Number.parseInt(match[3]);
                if (!Number.isNaN(sourceCol) && sourceCol !== 0) {
                    context.source.column = sourceCol;
                }
            } else {
                context.source = null;
            }
        } else {
            match = line.match(this.sourceD2Tag);
            if (match) {
                const sourceLine = Number.parseInt(match[1]);
                context.source = {
                    file: null,
                    line: sourceLine,
                };
            } else {
                match = line.match(this.sourceCVTag);
                if (match) {
                    // cv_loc reports: function file line column
                    const sourceLine = Number.parseInt(match[3]);
                    const file = utils.maskRootdir(context.files[Number.parseInt(match[2])]);
                    if (context.dontMaskFilenames) {
                        context.source = {
                            file: file,
                            line: sourceLine,
                            mainsource: this.stdInLooking.test(file),
                        };
                    } else {
                        context.source = {
                            file: this.stdInLooking.test(file) ? null : file,
                            line: sourceLine,
                        };
                    }
                    const sourceCol = Number.parseInt(match[4]);
                    if (!Number.isNaN(sourceCol) && sourceCol !== 0) {
                        context.source.column = sourceCol;
                    }
                }
            }
        }
    }

    protected handleStabs(context: ParsingContext, line: string) {
        const match = line.match(this.sourceStab);
        if (!match) return;
        // cf http://www.math.utah.edu/docs/info/stabs_11.html#SEC48
        switch (Number.parseInt(match[1])) {
            case 68: {
                context.source = {file: null, line: Number.parseInt(match[2])};
                break;
            }
            case 132:
            case 100: {
                context.source = null;
                context.prevLabel = '';
                break;
            }
        }
    }

    protected handle6502(context: ParsingContext, line: string) {
        const match = line.match(this.source6502Dbg);
        if (match) {
            const file = utils.maskRootdir(match[1]);
            const sourceLine = Number.parseInt(match[2]);
            if (context.dontMaskFilenames) {
                context.source = {
                    file: file,
                    line: sourceLine,
                    mainsource: this.stdInLooking.test(file),
                };
            } else {
                context.source = {
                    file: this.stdInLooking.test(file) ? null : file,
                    line: sourceLine,
                };
            }
        } else if (this.source6502DbgEnd.test(line)) {
            context.source = null;
        }
    }

    processAsm(asmResult: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
        if (filters.binary || filters.binaryObject) return this.processBinaryAsm(asmResult, filters);

        const startTime = process.hrtime.bigint();

        if (filters.commentOnly) {
            // Remove any block comments that start and end on a line if we're removing comment-only lines.
            asmResult = asmResult.replace(this.blockComments, '');
        }

        const asm: ParsedAsmResultLine[] = [];
        const labelDefinitions: Record<string, number> = {};

        let asmLines = utils.splitLines(asmResult);
        const startingLineCount = asmLines.length;
        if (filters.preProcessLines !== undefined) {
            asmLines = filters.preProcessLines(asmLines);
        }

        const labelsUsed = this.findUsedLabels(asmLines, filters.directives);

        let mayRemovePreviousLabel = true;
        let keepInlineCode = false;

        let lastOwnSource: AsmResultSource | undefined | null;

        const context: ParsingContext = {
            files: this.parseFiles(asmLines),
            source: null,
            prevLabel: '',
            prevLabelIsUserFunction: false,
            dontMaskFilenames: filters.dontMaskFilenames || false,
        };

        function maybeAddBlank() {
            const lastBlank = asm.length === 0 || asm[asm.length - 1].text === '';
            if (!lastBlank) asm.push({text: '', source: null, labels: []});
        }

        let inNvccDef = false;
        let inNvccCode = false;

        let inCustomAssembly = 0;
        let inVLIWpacket = false;

        let idxLine = 0;

        // TODO: Make this function smaller

        while (idxLine < asmLines.length) {
            let line = asmLines[idxLine];
            idxLine++;

            if (line.trim() === '') {
                maybeAddBlank();
                continue;
            }

            if (this.startAppBlock.test(line.trim()) || this.startAsmNesting.test(line.trim())) {
                inCustomAssembly++;
            } else if (this.endAppBlock.test(line.trim()) || this.endAsmNesting.test(line.trim())) {
                inCustomAssembly--;
            } else {
                inVLIWpacket = this.checkVLIWpacket(line, inVLIWpacket);
            }

            this.handleSource(context, line);
            this.handleStabs(context, line);
            this.handle6502(context, line);

            if (context.source && (context.source.file === null || context.source.mainsource)) {
                lastOwnSource = context.source;
            }

            if (this.endBlock.test(line) || (inNvccCode && /}/.test(line))) {
                context.source = null;
                context.prevLabel = '';
                lastOwnSource = null;
            }

            const doLibraryFilterCheck = filters.libraryCode && !context.prevLabelIsUserFunction;

            if (
                doLibraryFilterCheck &&
                !lastOwnSource &&
                context.source &&
                context.source.file !== null &&
                !context.source.mainsource
            ) {
                if (mayRemovePreviousLabel && asm.length > 0) {
                    const lastLine = asm[asm.length - 1];

                    const labelDef = lastLine.text ? lastLine.text.match(this.labelDef) : null;

                    if (labelDef) {
                        asm.pop();
                        keepInlineCode = false;
                        delete labelDefinitions[labelDef[1]];
                    } else {
                        keepInlineCode = true;
                    }
                    mayRemovePreviousLabel = false;
                }

                if (!keepInlineCode) {
                    continue;
                }
            } else {
                mayRemovePreviousLabel = true;
            }

            if (
                filters.commentOnly &&
                ((this.commentOnly.test(line) && !inNvccCode) || (this.commentOnlyNvcc.test(line) && inNvccCode))
            ) {
                continue;
            }

            if (inCustomAssembly > 0) line = this.fixLabelIndentation(line);

            let match = line.match(this.labelDef);
            if (!match) match = line.match(this.assignmentDef);
            if (!match) {
                match = line.match(this.cudaBeginDef);
                if (match) {
                    inNvccDef = true;
                    inNvccCode = true;
                }
            }
            if (match) {
                // It's a label definition.

                // g-as shows local labels as eg: "1:  call  mcount". We characterize such a label as "the
                // label-matching part doesn't equal the whole line" and treat it as used. As a special case, consider
                // assignments of the form "symbol = ." to be labels.
                if (
                    !labelsUsed.has(match[1]) &&
                    match[0] === line &&
                    (match[2] === undefined || match[2].trim() === '.')
                ) {
                    // It's an unused label.
                    if (filters.labels) {
                        context.prevLabel = '';
                        continue;
                    }
                } else {
                    // A used label.
                    context.prevLabel = match[1];
                    labelDefinitions[match[1]] = asm.length + 1;

                    if (!inNvccDef && !inNvccCode && filters.libraryCode) {
                        context.prevLabelIsUserFunction = this.isUserFunctionByLookingAhead(context, asmLines, idxLine);
                    }
                }
            }
            if (inNvccDef) {
                if (this.cudaEndDef.test(line)) inNvccDef = false;
            } else if (!match && filters.directives) {
                // Check for directives only if it wasn't a label; the regexp would otherwise misinterpret labels as
                // directives.
                if (this.dataDefn.test(line) && context.prevLabel) {
                    // We're defining data that's being used somewhere.
                } else {
                    // .inst generates an opcode, so does not count as a directive, nor does an alias definition that's
                    // used.
                    if (this.directive.test(line) && !this.instOpcodeRe.test(line) && !this.definesAlias.test(line)) {
                        continue;
                    }
                }
            }

            line = utils.expandTabs(line);
            const text = AsmRegex.filterAsmLine(line, filters);

            const labelsInLine = match ? [] : this.getUsedLabelsInLine(text);

            asm.push({
                text: text,
                source: this.hasOpcode(line, inNvccCode, inVLIWpacket) ? context.source || null : null,
                labels: labelsInLine,
            });
        }

        this.removeLabelsWithoutDefinition(asm, labelDefinitions);

        const endTime = process.hrtime.bigint();
        return {
            asm: asm,
            labelDefinitions: labelDefinitions,
            parsingTime: utils.deltaTimeNanoToMili(startTime, endTime),
            filteredCount: startingLineCount - asm.length,
        };
    }

    fixLabelIndentation(line: string) {
        const match = line.match(this.indentedLabelDef);
        if (match) {
            return line.replace(/^\s+/, '');
        }
        return line;
    }

    isUserFunction(func: string) {
        if (this.binaryHideFuncRe === null) return true;

        return !this.binaryHideFuncRe.test(func);
    }

    processBinaryAsm(asmResult: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
        const startTime = process.hrtime.bigint();
        const asm: ParsedAsmResultLine[] = [];
        const labelDefinitions: Record<string, number> = {};
        const dontMaskFilenames = filters.dontMaskFilenames;

        let asmLines = utils.splitLines(asmResult);
        const startingLineCount = asmLines.length;
        let source: AsmResultSource | undefined | null = null;
        let func: string | null = null;
        let mayRemovePreviousLabel = true;

        // Handle "error" documents.
        if (asmLines.length === 1 && asmLines[0][0] === '<') {
            return {
                asm: [{text: asmLines[0], source: null}],
            };
        }

        if (filters.preProcessBinaryAsmLines !== undefined) {
            asmLines = filters.preProcessBinaryAsmLines(asmLines);
        }

        for (const line of asmLines) {
            const labelsInLine: AsmResultLabel[] = [];

            if (asm.length >= this.maxAsmLines) {
                if (asm.length === this.maxAsmLines) {
                    asm.push({
                        text: '[truncated; too many lines]',
                        source: null,
                        labels: labelsInLine,
                    });
                }
                continue;
            }
            let match = line.match(this.lineRe);
            if (match) {
                assert(match.groups);
                if (dontMaskFilenames) {
                    source = {
                        file: utils.maskRootdir(match[1]),
                        line: Number.parseInt(match.groups.line),
                        mainsource: true,
                    };
                } else {
                    source = {file: null, line: Number.parseInt(match.groups.line), mainsource: true};
                }
                continue;
            }

            match = line.match(this.labelRe);
            if (match) {
                func = match[2];
                if (func && this.isUserFunction(func)) {
                    asm.push({
                        text: func + ':',
                        source: null,
                        labels: labelsInLine,
                    });
                    labelDefinitions[func] = asm.length;
                    if (process.platform === 'win32') source = null;
                }
                continue;
            }

            if (func && line === `${func}():`) continue;

            if (!func || !this.isUserFunction(func)) continue;

            // note: normally the source.file will be null if it's code from example.ext but with
            //  filters.dontMaskFilenames it will be filled with the actual filename instead we can test
            //  source.mainsource in that situation
            const isMainsource = source && (source.file === null || source.mainsource);
            if (filters.libraryCode && !isMainsource) {
                if (mayRemovePreviousLabel && asm.length > 0) {
                    const lastLine = asm[asm.length - 1];
                    if (lastLine.text && this.labelDef.test(lastLine.text)) {
                        asm.pop();
                    }
                    mayRemovePreviousLabel = false;
                }
                continue;
            }
            mayRemovePreviousLabel = true;

            match = line.match(this.asmOpcodeRe);
            if (match) {
                assert(match.groups);
                const address = Number.parseInt(match.groups.address, 16);
                const opcodes = (match.groups.opcodes || '').split(' ').filter(x => !!x);
                const disassembly = ' ' + AsmRegex.filterAsmLine(match.groups.disasm, filters);
                const destMatch = line.match(this.destRe);
                if (destMatch) {
                    const labelName = destMatch[2];
                    const startCol = disassembly.indexOf(labelName) + 1;
                    labelsInLine.push({
                        name: labelName,
                        range: {
                            startCol: startCol,
                            endCol: startCol + labelName.length,
                        },
                    });
                }
                asm.push({
                    opcodes: opcodes,
                    address: address,
                    text: disassembly,
                    source: source,
                    labels: labelsInLine,
                });
            }

            match = line.match(this.relocationRe);
            if (match) {
                assert(match.groups);
                const address = Number.parseInt(match.groups.address, 16);
                const relocname = match.groups.relocname;
                const relocdata = match.groups.relocdata;
                // value/addend matched but not used yet.
                // const match_value = relocdata.match(this.relocDataSymNameRe);
                asm.push({
                    text: `   ${relocname} ${relocdata}`,
                    address: address,
                });
            }
        }

        this.removeLabelsWithoutDefinition(asm, labelDefinitions);

        const endTime = process.hrtime.bigint();

        return {
            asm: asm,
            labelDefinitions: labelDefinitions,
            parsingTime: utils.deltaTimeNanoToMili(startTime, endTime),
            filteredCount: startingLineCount - asm.length,
        };
    }

    process(asm: string, filters: ParseFiltersAndOutputOptions) {
        return this.processAsm(asm, filters);
    }
}
