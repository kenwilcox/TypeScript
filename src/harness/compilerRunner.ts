/// <reference path='harness.ts' />
/// <reference path='runnerbase.ts' />
/// <reference path='typeWriter.ts' />
/// <reference path='syntacticCleaner.ts' />

enum CompilerTestType {
    Conformance,
    Regressions,
    Test262
}

class CompilerBaselineRunner extends RunnerBase {
    private basePath = 'tests/cases';
    private errors: boolean;
    private emit: boolean;
    private decl: boolean;
    private output: boolean;

    public options: string;

    constructor(public testType?: CompilerTestType) {
        super();
        this.errors = true;
        this.emit = true;
        this.decl = true;
        this.output = true;
        if (testType === CompilerTestType.Conformance) {
            this.basePath += '/conformance';
        }
        else if (testType === CompilerTestType.Regressions) {
            this.basePath += '/compiler';
        }
        else if (testType === CompilerTestType.Test262) {
            this.basePath += '/test262';
        } else {
            this.basePath += '/compiler'; // default to this for historical reasons
        }
    }

    public checkTestCodeOutput(fileName: string) {
        describe('compiler tests for ' + fileName, () => {
            // strips the fileName from the path.
            var justName = fileName.replace(/^.*[\\\/]/, '');
            var content = Harness.IO.readFile(fileName);
            var testCaseContent = Harness.TestCaseParser.makeUnitsFromTest(content, fileName);

            var units = testCaseContent.testUnitData;
            var tcSettings = testCaseContent.settings;
            var createNewInstance = false;

            var lastUnit = units[units.length - 1];

            var result: Harness.Compiler.CompilerResult;
            var options: ts.CompilerOptions;
            // equivalent to the files that will be passed on the command line
            var toBeCompiled: { unitName: string; content: string }[];
            // equivalent to other files on the file system not directly passed to the compiler (ie things that are referenced by other files)
            var otherFiles: { unitName: string; content: string }[];
            var harnessCompiler: Harness.Compiler.HarnessCompiler;

            var createNewInstance = false;

            before(() => {
                harnessCompiler = Harness.Compiler.getCompiler();
                // We need to assemble the list of input files for the compiler and other related files on the 'filesystem' (ie in a multi-file test)
                // If the last file in a test uses require or a triple slash reference we'll assume all other files will be brought in via references,
                // otherwise, assume all files are just meant to be in the same compilation session without explicit references to one another.
                toBeCompiled = [];
                otherFiles = [];
                var rootDir = lastUnit.originalFilePath.indexOf('conformance') === -1 ? 'tests/cases/compiler/' : lastUnit.originalFilePath.substring(0, lastUnit.originalFilePath.lastIndexOf('/')) + '/';
                if (/require\(/.test(lastUnit.content) || /reference\spath/.test(lastUnit.content)) {
                    toBeCompiled.push({ unitName: rootDir + lastUnit.name, content: lastUnit.content });
                    units.forEach(unit => {
                        if (unit.name !== lastUnit.name) {
                            otherFiles.push({ unitName: rootDir + unit.name, content: unit.content });
                        }
                    });
                } else {
                    toBeCompiled = units.map(unit => {
                        return { unitName: rootDir + unit.name, content: unit.content };
                    });
                }

                options = harnessCompiler.compileFiles(toBeCompiled, otherFiles, function (compileResult) {
                    result = compileResult;
                }, function (settings) {
                        harnessCompiler.setCompilerSettings(tcSettings);
                    });
            });

            beforeEach(() => {
                /* The compiler doesn't handle certain flags flipping during a single compilation setting. Tests on these flags will need 
                   a fresh compiler instance for themselves and then create a fresh one for the next test. Would be nice to get dev fixes
                   eventually to remove this limitation. */
                for (var i = 0; i < tcSettings.length; ++i) {
                    if (!createNewInstance && (tcSettings[i].flag == "noimplicitany" || tcSettings[i].flag === 'target')) {
                        harnessCompiler = Harness.Compiler.getCompiler({
                            useExistingInstance: false,
                            optionsForFreshInstance: { useMinimalDefaultLib: true, noImplicitAny: tcSettings[i].flag === "noimplicitany" }
                        });
                        harnessCompiler.setCompilerSettings(tcSettings);
                        createNewInstance = true;
                    }
                }
            });

            afterEach(() => {
                if (createNewInstance) {
                    harnessCompiler = Harness.Compiler.getCompiler({
                        useExistingInstance: false,
                        optionsForFreshInstance: { useMinimalDefaultLib: true, noImplicitAny: false }
                    });
                    createNewInstance = false;
                }
            });

            // check errors
            it('Correct errors for ' + fileName, () => {
                if (this.errors) {
                    Harness.Baseline.runBaseline('Correct errors for ' + fileName, justName.replace(/\.ts$/, '.errors.txt'), (): string => {
                        if (result.errors.length === 0) return null;

                        var outputLines: string[] = [];
                        // Count up all the errors we find so we don't miss any
                        var totalErrorsReported = 0;

                        // 'merge' the lines of each input file with any errors associated with it
                        toBeCompiled.concat(otherFiles).forEach(inputFile => {
                            // Filter down to the errors in the file
                            // TODO/REVIEW: this doesn't work quite right in the browser if a multi file test has files whose names are just the right length relative to one another
                            var fileErrors = result.errors.filter(e => {
                                var errFn = e.filename;
                                return errFn && errFn.indexOf(inputFile.unitName) === errFn.length - inputFile.unitName.length;
                            });

                            // Add this to the number of errors we've seen so far
                            totalErrorsReported += fileErrors.length;

                            // Header
                            outputLines.push('==== ' + inputFile.unitName + ' (' + fileErrors.length + ' errors) ====');

                            // Make sure we emit something for every error
                            var markedErrorCount = 0;
                            // For each line, emit the line followed by any error squiggles matching this line
                            // Note: IE JS engine incorrectly handles consecutive delimiters here when using RegExp split, so
                            // we have to string-based splitting instead and try to figure out the delimiting chars
                            
                            // var fileLineMap = TypeScript.LineMap1.fromString(inputFile.content);
                            var lines = inputFile.content.split('\n');
                            var currentLineStart = 0;
                            lines.forEach((line, lineIndex) => {
                                if (line.length > 0 && line.charAt(line.length - 1) === '\r') {
                                    line = line.substr(0, line.length - 1);
                                }

                                var thisLineStart = currentLineStart; //fileLineMap.getLineStartPosition(lineIndex);
                                var nextLineStart: number;
                                // On the last line of the file, fake the next line start number so that we handle errors on the last character of the file correctly
                                if (lineIndex === lines.length - 1) {
                                    nextLineStart = inputFile.content.length;
                                } else {
                                    nextLineStart = currentLineStart + line.length + 1; //fileLineMap.getLineStartPosition(lineIndex + 1);
                                }
                                // Emit this line from the original file
                                outputLines.push('    ' + line);
                                fileErrors.forEach(err => {
                                    // Does any error start or continue on to this line? Emit squiggles
                                    if ((err.end >= thisLineStart) && ((err.start < nextLineStart) || (lineIndex === lines.length - 1))) {
                                        // How many characters from the start of this line the error starts at (could be positive or negative)
                                        var relativeOffset = err.start - thisLineStart;
                                        // How many characters of the error are on this line (might be longer than this line in reality)
                                        var length = (err.end - err.start) - Math.max(0, thisLineStart - err.start);
                                        // Calculate the start of the squiggle
                                        var squiggleStart = Math.max(0, relativeOffset);
                                        // TODO/REVIEW: this doesn't work quite right in the browser if a multi file test has files whose names are just the right length relative to one another
                                        outputLines.push('    ' + line.substr(0, squiggleStart).replace(/[^\s]/g, ' ') + new Array(Math.min(length, line.length - squiggleStart) + 1).join('~'));
                                        
                                        // If the error ended here, or we're at the end of the file, emit its message
                                        if ((lineIndex === lines.length - 1) || nextLineStart > err.end) {
                                            // Just like above, we need to do a split on a string instead of on a regex
                                            // because the JS engine does regexes wrong

                                            var errLines = RunnerBase.removeFullPaths(err.message)
                                                .split('\n')
                                                .map(s => s.length > 0 && s.charAt(s.length - 1) === '\r' ? s.substr(0, s.length - 1) : s)
                                                .filter(s => s.length > 0)
                                                .map(s => '!!! ' + s);
                                            errLines.forEach(e => outputLines.push(e));
                                            markedErrorCount++;
                                        }
                                    }
                                });
                                currentLineStart += line.length + 1; // +1 for the \n character
                            });

                            // Verify we didn't miss any errors in this file
                            assert.equal(markedErrorCount, fileErrors.length, 'count of errors in ' + inputFile.unitName);
                        });

                        // Verify we didn't miss any errors in total
                        // NEWTODO: Re-enable this -- somehow got broken
                        // assert.equal(totalErrorsReported, result.errors.length, 'total number of errors');

                        return outputLines.join('\r\n');
                    });
                }
            });

            // Source maps?
            it('Correct sourcemap content for ' + fileName, () => {
                if (result.sourceMapRecord) {
                    Harness.Baseline.runBaseline('Correct sourcemap content for ' + fileName, justName.replace(/\.ts$/, '.sourcemap.txt'), () => {
                        return result.sourceMapRecord;
                    });
                }
            });

            /*
            it(".d.ts compiles without error", () => {
                // if the .d.ts is non-empty, confirm it compiles correctly as well
                if (this.decl && result.declFilesCode.length > 0 && result.errors.length === 0) {

                    var declErrors: string[] = undefined;

                    var declOtherFiles: { unitName: string; content: string }[] = [];

                    // use other files if it is dts
                    for (var i = 0; i < otherFiles.length; i++) {
                        if (TypeScript.isDTSFile(otherFiles[i].unitName)) {
                            declOtherFiles.push(otherFiles[i]);
                        }
                    }

                    for (var i = 0; i < result.declFilesCode.length; i++) {
                        var declCode = result.declFilesCode[i];
                        // don't want to use the fullpath for the unitName or the file won't be resolved correctly
                        // TODO: wrong path for conformance tests?

                        var declFile = { unitName: 'tests/cases/compiler/' + Harness.getFileName(declCode.fileName), content: declCode.code };
                        if (i != result.declFilesCode.length - 1) {
                            declOtherFiles.push(declFile);
                        }
                    }

                    harnessCompiler.compileFiles(
                        [declFile],
                        declOtherFiles,
                        (result) => {
                            declErrors = result.errors.map(err => err.message + "\r\n");
                        },
                        function (settings) {
                            harnessCompiler.setCompilerSettings(tcSettings);
                        });

                    if (declErrors && declErrors.length) {
                        throw new Error('.d.ts file output of ' + fileName + ' did not compile. Errors: ' + declErrors.map(err => JSON.stringify(err)).join('\r\n'));
                    }
                }
            });
            */

            it('Correct JS output for ' + fileName, () => {
                if (!ts.fileExtensionIs(lastUnit.name, '.d.ts') && this.emit) {
                    if (result.files.length === 0 && result.errors.length === 0) {
                        throw new Error('Expected at least one js file to be emitted or at least one error to be created.');
                    }

                    // check js output
                    Harness.Baseline.runBaseline('Correct JS output for ' + fileName, justName.replace(/\.ts/, '.js'), () => {
                        var tsCode = '';
                        var tsSources = otherFiles.concat(toBeCompiled);
                        if (tsSources.length > 1) {
                            tsCode += '//// [' + fileName + '] ////\r\n\r\n';
                        }
                        for (var i = 0; i < tsSources.length; i++) {
                            tsCode += '//// [' + Harness.Path.getFileName(tsSources[i].unitName) + ']\r\n';
                            tsCode += tsSources[i].content + (i < (tsSources.length - 1) ? '\r\n' : '');
                        }

                        var jsCode = '';
                        for (var i = 0; i < result.files.length; i++) {
                            jsCode += '//// [' + Harness.Path.getFileName(result.files[i].fileName) + ']\r\n';
                            jsCode += result.files[i].code;
                            // Re-enable this if we want to do another comparison of old vs new compiler baselines
                            // jsCode += SyntacticCleaner.clean(result.files[i].code);
                        }

                        if (result.declFilesCode.length > 0) {
                            jsCode += '\r\n\r\n';
                            for (var i = 0; i < result.files.length; i++) {
                                jsCode += '//// [' + Harness.Path.getFileName(result.declFilesCode[i].fileName) + ']\r\n';
                                jsCode += result.declFilesCode[i].code;
                            }
                        }

                        if (jsCode.length > 0) {
                            return tsCode + '\r\n\r\n' + jsCode;
                        } else {
                            return null;
                        }
                    });
                }
            });

            it('Correct Sourcemap output for ' + fileName, () => {
                if (options.sourceMap) {
                    if (result.sourceMaps.length !== result.files.length) {
                        throw new Error('Number of sourcemap files should be same as js files.');
                    }

                    Harness.Baseline.runBaseline('Correct Sourcemap output for ' + fileName, justName.replace(/\.ts/, '.js.map'), () => {
                        var sourceMapCode = '';
                        for (var i = 0; i < result.sourceMaps.length; i++) {
                            sourceMapCode += '//// [' + Harness.Path.getFileName(result.sourceMaps[i].fileName) + ']\r\n';
                            sourceMapCode += result.sourceMaps[i].code;
                        }

                        return sourceMapCode;
                    });
                }
            });

            it('Correct type baselines for ' + fileName, () => {
                // NEWTODO: Type baselines
                if (/* ! */ false && /* ! */ result.errors.length === 0) {
                    Harness.Baseline.runBaseline('Correct expression types for ' + fileName, justName.replace(/\.ts/, '.types'), () => {
                        // TODO: Rewrite this part
                        //var compiler = new TypeScript.TypeScriptCompiler(
                        //    new TypeScript.NullLogger(), TypeScript.ImmutableCompilationSettings.defaultSettings());

                        //compiler.addFile('lib.d.ts', TypeScript.ScriptSnapshot.fromString(Harness.Compiler.libTextMinimal),
                        //    TypeScript.ByteOrderMark.None, /*version:*/ "0", /*isOpen:*/ true);

                        //var allFiles = toBeCompiled.concat(otherFiles);
                        //allFiles.forEach(file => {
                        //    compiler.addFile(file.unitName, TypeScript.ScriptSnapshot.fromString(file.content),
                        //        TypeScript.ByteOrderMark.None, /*version:*/ "0", /*isOpen:*/ true);
                        //});

                        var allFiles: any[] = [];
                        var compiler: any = undefined;

                        var typeBaselineText = '';
                        var typeLines: string[] = [];
                        var typeMap: { [fileName: string]: { [lineNum: number]: string[]; } } = {};
                        allFiles.forEach(file => {
                            var codeLines = file.content.split('\n');
                            var walker = new TypeWriterWalker(file.unitName, compiler);
                            walker.run();
                            walker.results.forEach(result => {
                                var formattedLine = result.identifierName + " : " + result.type;
                                if (!typeMap[file.unitName]) {
                                    typeMap[file.unitName] = {}
                                }

                                var typeInfo = [formattedLine];
                                var existingTypeInfo = typeMap[file.unitName][result.line];
                                if (existingTypeInfo) {
                                    typeInfo = existingTypeInfo.concat(typeInfo);
                                }
                                typeMap[file.unitName][result.line] = typeInfo;
                            });

                            var typeBaselineText = '';
                            var typeLines: string[] = [];
                            var typeMap: { [fileName: string]: { [lineNum: number]: string[]; } } = {};
                            allFiles.forEach(file => {
                                var codeLines = file.content.split('\n');
                                var walker = new TypeWriterWalker(file.unitName, compiler);
                                walker.run();
                                walker.results.forEach(result => {
                                    var formattedLine = result.identifierName + " : " + result.type;
                                    if (!typeMap[file.unitName]) {
                                        typeMap[file.unitName] = {}
                                    } else {
                                        typeLines.push('No type information for this code.');
                                    }
                                });
                            });

                            typeLines.push('=== ' + file.unitName + ' ===\r\n');
                            for (var i = 0; i < codeLines.length; i++) {
                                var currentCodeLine = codeLines[i];
                                var lastLine = typeLines[typeLines.length];
                                typeLines.push(currentCodeLine + '\r\n');
                                if (typeMap[file.unitName]) {
                                    var typeInfo = typeMap[file.unitName][i];
                                    if (typeInfo) {
                                        var leadingSpaces = '';
                                        typeInfo.forEach(ty => {
                                            typeLines.push('>' + ty + '\r\n');
                                        });
                                        if (i + 1 < codeLines.length && (codeLines[i + 1].match(/^\s*[{|}]\s*$/) || codeLines[i + 1].trim() === '')) {
                                        } else {
                                            typeLines.push('\r\n');
                                        }
                                    }
                                } else {
                                    typeLines.push('No type information for this code.');
                                }
                            }
                        });

                        return typeLines.join('');
                    });
                }
            });
        });
    }

    public initializeTests() {
        describe("Setup compiler for compiler baselines", () => {
            var harnessCompiler = Harness.Compiler.getCompiler({
                useExistingInstance: false,
                optionsForFreshInstance: { useMinimalDefaultLib: true, noImplicitAny: false }
            });
            this.parseOptions();
        });

        // this will set up a series of describe/it blocks to run between the setup and cleanup phases
        if (this.tests.length === 0) {
            var testFiles = this.enumerateFiles(this.basePath, /\.ts$/, { recursive: true });
            testFiles.forEach(fn => {
                fn = fn.replace(/\\/g, "/");
                this.checkTestCodeOutput(fn);
            });
        }
        else {
            this.tests.forEach(test => this.checkTestCodeOutput(test));
        }

        describe("Cleanup after compiler baselines", () => {
            var harnessCompiler = Harness.Compiler.getCompiler({
                useExistingInstance: false,
                optionsForFreshInstance: { useMinimalDefaultLib: true, noImplicitAny: false }
            });
        });
    }

    private parseOptions() {
        if (this.options && this.options.length > 0) {
            this.errors = false;
            this.emit = false;
            this.decl = false;
            this.output = false;

            var opts = this.options.split(',');
            for (var i = 0; i < opts.length; i++) {
                switch (opts[i]) {
                    case 'error':
                        this.errors = true;
                        break;
                    case 'emit':
                        this.emit = true;
                        break;
                    case 'decl':
                        this.decl = true;
                        break;
                    case 'output':
                        this.output = true;
                        break;
                    default:
                        throw new Error('unsupported flag');
                }
            }
        }
    }
}