// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
// src/ast.ts
function walk(value, enterOrVisitors) {
	const isEnter = typeof enterOrVisitors === "function";
	const enter = isEnter ? enterOrVisitors : enterOrVisitors.enter;
	const exit = isEnter ? null : enterOrVisitors.exit;
	const visitEntries = (container, parent) => {
		for (const [key, entry] of Object.entries(container)) if (visit(entry, parent, key, null)) return true;
		return false;
	};
	const visit = (child, parent, prop, index) => {
		if (Array.isArray(child)) {
			let i = 0;
			for (const item of child) {
				if (visit(item, parent, prop, i)) return true;
				i += 1;
			}
			return false;
		}
		if (child == null || typeof child !== "object") return false;
		if (typeof child.type !== "string") return visitEntries(child, parent);
		const node = child;
		if (enter?.(node, parent, prop, index) !== false && visitEntries(node, node)) return true;
		return exit?.(node, parent, prop, index) === false;
	};
	visit(value, null, null, null);
}
/** Reports whether an error was caused by incomplete shell source. */
const isIncomplete = (error) => Boolean(error?.incomplete);
// src/source.ts
const MAX_CODE_POINT_BYTES = 4;
const ONE_BYTE_LEAD_MAX = 127;
const TWO_BYTE_LEAD_MAX = 223;
const THREE_BYTE_LEAD_MAX = 239;
/**
* Builds a converter from a source string's UTF-8 byte offsets to UTF-16 code-unit offsets. Byte
* offsets inside a multi-byte character map to the start of that character; offsets outside the
* string are clamped.
*/
const createSourceIndex = (text) => {
	const end = text.length;
	const bytes = new TextEncoder().encode(text);
	if (bytes.length === end) return (byteOffset) => Math.min(Math.max(byteOffset, 0), end);
	const map = new Uint32Array(bytes.length + 1);
	let codeUnit = 0;
	for (let i = 0; i < bytes.length;) {
		const lead = bytes[i];
		if (lead <= ONE_BYTE_LEAD_MAX) {
			map[i] = codeUnit;
			codeUnit += 1;
			i += 1;
			continue;
		}
		let byteLength = MAX_CODE_POINT_BYTES;
		if (lead <= TWO_BYTE_LEAD_MAX) byteLength = 2;
		else if (lead <= THREE_BYTE_LEAD_MAX) byteLength = 3;
		map.fill(codeUnit, i, i + byteLength);
		codeUnit += byteLength >> 1;
		i += byteLength;
	}
	map[bytes.length] = codeUnit;
	return (byteOffset) => {
		if (byteOffset <= 0) return 0;
		return map[byteOffset] ?? end;
	};
};
// src/operators.ts
const BinAritOperator = {
	Add: 81,
	AddAssgn: 49,
	And: 10,
	AndArit: 11,
	AndAssgn: 54,
	AndBoolAssgn: 59,
	Assgn: 87,
	Comma: 98,
	Eql: 45,
	Geq: 48,
	Gtr: 63,
	Leq: 47,
	Lss: 65,
	Mul: 43,
	MulAssgn: 51,
	Neq: 46,
	Or: 13,
	OrArit: 12,
	OrAssgn: 55,
	OrBoolAssgn: 60,
	Pow: 44,
	PowAssgn: 62,
	Quo: 101,
	QuoAssgn: 52,
	Rem: 89,
	RemAssgn: 53,
	Shl: 71,
	ShlAssgn: 57,
	Shr: 64,
	ShrAssgn: 58,
	Sub: 83,
	SubAssgn: 50,
	TernColon: 104,
	TernQuest: 85,
	Xor: 96,
	XorAssgn: 56,
	XorBool: 97,
	XorBoolAssgn: 61
};
const BinCmdOperator = {
	AndStmt: 11,
	OrStmt: 12,
	Pipe: 13,
	PipeAll: 14
};
const BinTestOperator = {
	AndTest: 11,
	OrTest: 12,
	TsAfter: 63,
	TsBefore: 65,
	TsDevIno: 132,
	TsEql: 133,
	TsGeq: 136,
	TsGtr: 138,
	TsLeq: 135,
	TsLss: 137,
	TsMatch: 45,
	TsMatchShort: 87,
	TsNeq: 134,
	TsNewer: 130,
	TsNoMatch: 46,
	TsOlder: 131,
	TsReMatch: 129
};
const CaseOperator = {
	Break: 35,
	Fallthrough: 36,
	Resume: 37,
	ResumeKorn: 38
};
const GlobOperator = {
	GlobExcept: 143,
	GlobOne: 142,
	GlobOneOrMore: 141,
	GlobZeroOrMore: 140,
	GlobZeroOrOne: 139
};
const ParExpOperator = {
	AlternateUnset: 81,
	AlternateUnsetOrNull: 82,
	ArrayExclude: 94,
	ArrayIntersect: 95,
	AssignUnset: 87,
	AssignUnsetOrNull: 88,
	DefaultUnset: 83,
	DefaultUnsetOrNull: 84,
	ErrorUnset: 85,
	ErrorUnsetOrNull: 86,
	LowerAll: 99,
	LowerFirst: 98,
	MatchEmpty: 93,
	OtherParamOps: 100,
	RemLargePrefix: 92,
	RemLargeSuffix: 90,
	RemSmallPrefix: 91,
	RemSmallSuffix: 89,
	UpperAll: 97,
	UpperFirst: 96
};
const ParNamesOperator = {
	NamesPrefix: 43,
	NamesPrefixWords: 100,
	None: 0
};
const ProcOperator = {
	CmdIn: 78,
	CmdInTemp: 79,
	CmdOut: 80
};
const RedirOperator = {
	AppAll: 76,
	AppAllClob: 77,
	AppClob: 70,
	AppOut: 64,
	ClbOut: 69,
	DashHdoc: 72,
	DplIn: 67,
	DplOut: 68,
	Hdoc: 71,
	RdrAll: 74,
	RdrAllClob: 75,
	RdrClob: 69,
	RdrIn: 65,
	RdrInOut: 66,
	RdrOut: 63,
	WordHdoc: 73
};
const UnAritOperator = {
	BitNegation: 40,
	Dec: 42,
	Inc: 41,
	Minus: 83,
	Not: 39,
	Plus: 81
};
const UnTestOperator = {
	TsBlckSp: 109,
	TsCharSp: 108,
	TsDirect: 107,
	TsEmpStr: 124,
	TsExec: 121,
	TsExists: 105,
	TsFdTerm: 123,
	TsGIDSet: 114,
	TsGrpOwn: 116,
	TsModif: 118,
	TsNempStr: 125,
	TsNmPipe: 110,
	TsNoEmpty: 122,
	TsNot: 39,
	TsOptSet: 126,
	TsParen: 27,
	TsRead: 119,
	TsRefVar: 128,
	TsRegFile: 106,
	TsSmbLink: 112,
	TsSocket: 111,
	TsSticky: 113,
	TsUIDSet: 115,
	TsUsrOwn: 117,
	TsVarSet: 127,
	TsWrite: 120
};
// src/types.ts
const LangVariant = {
	/**
	* LangBash corresponds to the GNU Bash language, as described in its manual at
	* https://www.gnu.org/software/bash/manual/bash.html.
	*
	* We currently follow Bash version 5.2.
	*
	* Its string representation is "bash".
	*
	* Note: as of mvdan/sh v3.13, {@link LangVariant} values are bit flags (`1 << iota`) rather than
	* a sequential enum, so every value changed from the previous release.
	*/
	LangBash: 1,
	/**
	* LangPOSIX corresponds to the POSIX Shell language, as described at
	* https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html.
	*
	* Its string representation is "posix" or "sh".
	*/
	LangPOSIX: 2,
	/**
	* LangMirBSDKorn corresponds to the MirBSD Korn Shell, also known as mksh, as described at
	* https://www.mirbsd.org/htman/i386/man1/mksh.htm. Note that it shares some features with Bash,
	* due to the shared ancestry that is ksh.
	*
	* We currently follow mksh version 59.
	*
	* Its string representation is "mksh".
	*/
	LangMirBSDKorn: 4,
	/**
	* LangBats corresponds to the Bash Automated Testing System language, as described at
	* https://github.com/bats-core/bats-core. Note that it's just a small extension of the Bash
	* language.
	*
	* Its string representation is "bats".
	*/
	LangBats: 8,
	/**
	* LangZsh corresponds to the Z shell, as described at https://www.zsh.org/.
	*
	* Note that its support in mvdan/sh is experimental and incomplete for now; see
	* https://github.com/mvdan/sh/issues/120. We currently follow Zsh version 5.9. Added in mvdan/sh
	* v3.13.0.
	*
	* Its string representation is "zsh".
	*/
	LangZsh: 16,
	/**
	* LangAuto corresponds to automatic language detection, commonly used by end-user applications
	* like shfmt, which can guess a file's language variant given its filename or shebang.
	*
	* At this time, [Variant] does not support LangAuto.
	*/
	LangAuto: 32
};
// src/common.ts
/** Stable error codes for callers that should not depend on messages. */
const ErrorCode = {
	Parse: "SH_SYNTAX_PARSE",
	Language: "SH_SYNTAX_LANGUAGE",
	Input: "SH_SYNTAX_INPUT",
	Print: "SH_SYNTAX_PRINT",
	SplitBraces: "SH_SYNTAX_SPLIT_BRACES"
};
var ShSyntaxError = class extends SyntaxError {
	constructor(code, message) {
		super(message);
		this.name = "ShSyntaxError";
		this.code = code;
	}
};
var ParseError = class extends ShSyntaxError {
	constructor({ filename, incomplete, text, pos }) {
		super(ErrorCode.Parse, text);
		this.name = "ParseError";
		this.filename = filename;
		this.incomplete = incomplete;
		this.text = text;
		this.pos = pos;
	}
};
var InputError = class extends TypeError {
	constructor(..._args) {
		super(..._args);
		this.code = ErrorCode.Input;
		this.name = "InputError";
	}
};
// src/wire-schema.ts
const WIRE_TYPES = {
	ArithmCmd: 1,
	ArithmExp: 2,
	ArrayElem: 3,
	ArrayExpr: 4,
	Assign: 5,
	BinaryArithm: 6,
	BinaryCmd: 7,
	BinaryTest: 8,
	Block: 9,
	BraceExp: 10,
	CStyleLoop: 11,
	CallArithm: 12,
	CallExpr: 13,
	CaseClause: 14,
	CaseItem: 15,
	CmdSubst: 16,
	Comment: 17,
	CoprocClause: 18,
	DblQuoted: 19,
	DeclClause: 20,
	ExtGlob: 21,
	File: 22,
	FlagsArithm: 23,
	ForClause: 24,
	FuncDecl: 25,
	IfClause: 26,
	LetClause: 27,
	Lit: 28,
	ParamExp: 29,
	ParenArithm: 30,
	ParenTest: 31,
	ProcSubst: 32,
	Redirect: 33,
	RepeatClause: 34,
	SglQuoted: 35,
	Stmt: 36,
	Subshell: 37,
	TestClause: 38,
	TestDecl: 39,
	TimeClause: 40,
	TryClause: 41,
	UnaryArithm: 42,
	UnaryTest: 43,
	WhileClause: 44,
	Word: 45,
	WordIter: 46
};
const WIRE_SCHEMA = {
	File: {
		node: true,
		fields: [
			["name", { k: "string" }],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	Comment: {
		node: true,
		fields: [["hash", { k: "pos" }], ["text", { k: "string" }]]
	},
	Stmt: {
		node: true,
		fields: [
			["comments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["cmd", {
				k: "iface",
				t: "Command"
			}],
			["position", { k: "pos" }],
			["semicolon", { k: "pos" }],
			["negated", { k: "bool" }],
			["background", { k: "bool" }],
			["coprocess", { k: "bool" }],
			["disown", { k: "bool" }],
			["redirs", {
				k: "slice",
				e: {
					k: "ref",
					t: "Redirect",
					n: true
				}
			}]
		]
	},
	Assign: {
		node: true,
		fields: [
			["append", { k: "bool" }],
			["naked", { k: "bool" }],
			["name", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["index", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["value", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["array", {
				k: "ref",
				t: "ArrayExpr",
				n: true
			}]
		]
	},
	Redirect: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["closePos", { k: "pos" }],
			["op", { k: "uint" }],
			["n", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["word", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["hdoc", {
				k: "ref",
				t: "Word",
				n: true
			}]
		]
	},
	CallExpr: {
		node: true,
		fields: [["assigns", {
			k: "slice",
			e: {
				k: "ref",
				t: "Assign",
				n: true
			}
		}], ["args", {
			k: "slice",
			e: {
				k: "ref",
				t: "Word",
				n: true
			}
		}]]
	},
	Subshell: {
		node: true,
		fields: [
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	Block: {
		node: true,
		fields: [
			["lbrace", { k: "pos" }],
			["rbrace", { k: "pos" }],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	TryClause: {
		node: true,
		fields: [
			["try", {
				k: "ref",
				t: "Block",
				n: true
			}],
			["alwaysPos", { k: "pos" }],
			["always", {
				k: "ref",
				t: "Block",
				n: true
			}]
		]
	},
	IfClause: {
		node: true,
		fields: [
			["position", { k: "pos" }],
			["thenPos", { k: "pos" }],
			["fiPos", { k: "pos" }],
			["cond", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["condComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["then", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["thenComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["else", {
				k: "ref",
				t: "IfClause",
				n: true
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	WhileClause: {
		node: true,
		fields: [
			["whilePos", { k: "pos" }],
			["doPos", { k: "pos" }],
			["donePos", { k: "pos" }],
			["until", { k: "bool" }],
			["cond", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["condComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["do", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["doComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	ForClause: {
		node: true,
		fields: [
			["forPos", { k: "pos" }],
			["doPos", { k: "pos" }],
			["donePos", { k: "pos" }],
			["select", { k: "bool" }],
			["braces", { k: "bool" }],
			["loop", {
				k: "iface",
				t: "Loop"
			}],
			["do", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["doComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	RepeatClause: {
		node: true,
		fields: [
			["repeatPos", { k: "pos" }],
			["doPos", { k: "pos" }],
			["donePos", { k: "pos" }],
			["braces", { k: "bool" }],
			["count", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["do", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["doComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	WordIter: {
		node: true,
		fields: [
			["name", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["names", {
				k: "slice",
				e: {
					k: "ref",
					t: "Lit",
					n: true
				}
			}],
			["inPos", { k: "pos" }],
			["items", {
				k: "slice",
				e: {
					k: "ref",
					t: "Word",
					n: true
				}
			}]
		]
	},
	CStyleLoop: {
		node: true,
		fields: [
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["init", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["cond", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["post", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	BinaryCmd: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["x", {
				k: "ref",
				t: "Stmt",
				n: true
			}],
			["y", {
				k: "ref",
				t: "Stmt",
				n: true
			}]
		]
	},
	FuncDecl: {
		node: true,
		fields: [
			["position", { k: "pos" }],
			["rsrvWord", { k: "bool" }],
			["parens", { k: "bool" }],
			["name", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["names", {
				k: "slice",
				e: {
					k: "ref",
					t: "Lit",
					n: true
				}
			}],
			["body", {
				k: "ref",
				t: "Stmt",
				n: true
			}],
			["args", {
				k: "slice",
				e: {
					k: "ref",
					t: "Word",
					n: true
				}
			}]
		]
	},
	Word: {
		node: true,
		fields: [["parts", {
			k: "slice",
			e: {
				k: "iface",
				t: "WordPart"
			}
		}]]
	},
	Lit: {
		node: true,
		fields: [
			["valuePos", { k: "pos" }],
			["valueEnd", { k: "pos" }],
			["value", { k: "string" }]
		]
	},
	SglQuoted: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["dollar", { k: "bool" }],
			["value", { k: "string" }]
		]
	},
	DblQuoted: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["dollar", { k: "bool" }],
			["parts", {
				k: "slice",
				e: {
					k: "iface",
					t: "WordPart"
				}
			}]
		]
	},
	CmdSubst: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["backquotes", { k: "bool" }],
			["tempFile", { k: "bool" }],
			["replyVar", { k: "bool" }]
		]
	},
	ParamExp: {
		node: true,
		fields: [
			["dollar", { k: "pos" }],
			["rbrace", { k: "pos" }],
			["short", { k: "bool" }],
			["flags", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["excl", { k: "bool" }],
			["length", { k: "bool" }],
			["width", { k: "bool" }],
			["isSet", { k: "bool" }],
			["split", { k: "uint" }],
			["globSubst", { k: "uint" }],
			["rcExpand", { k: "uint" }],
			["param", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["nestedParam", {
				k: "iface",
				t: "WordPart"
			}],
			["index", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["subscripts", {
				k: "slice",
				e: {
					k: "iface",
					t: "ArithmExpr"
				}
			}],
			["modifiers", {
				k: "slice",
				e: {
					k: "ref",
					t: "Lit",
					n: true
				}
			}],
			["slice", {
				k: "ref",
				t: "Slice",
				n: true
			}],
			["repl", {
				k: "ref",
				t: "Replace",
				n: true
			}],
			["names", { k: "uint" }],
			["exp", {
				k: "ref",
				t: "Expansion",
				n: true
			}]
		]
	},
	Slice: {
		node: false,
		fields: [["offset", {
			k: "iface",
			t: "ArithmExpr"
		}], ["length", {
			k: "iface",
			t: "ArithmExpr"
		}]]
	},
	Replace: {
		node: false,
		fields: [
			["all", { k: "bool" }],
			["orig", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["with", {
				k: "ref",
				t: "Word",
				n: true
			}]
		]
	},
	Expansion: {
		node: false,
		fields: [["op", { k: "uint" }], ["word", {
			k: "ref",
			t: "Word",
			n: true
		}]]
	},
	ArithmExp: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["bracket", { k: "bool" }],
			["unsigned", { k: "bool" }],
			["x", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	ArithmCmd: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["unsigned", { k: "bool" }],
			["x", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	BinaryArithm: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["x", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["y", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	UnaryArithm: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["post", { k: "bool" }],
			["x", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	ParenArithm: {
		node: true,
		fields: [
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["x", {
				k: "iface",
				t: "ArithmExpr"
			}]
		]
	},
	FlagsArithm: {
		node: true,
		fields: [["flags", {
			k: "ref",
			t: "Lit",
			n: true
		}], ["x", {
			k: "iface",
			t: "ArithmExpr"
		}]]
	},
	CallArithm: {
		node: true,
		fields: [
			["name", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["args", {
				k: "slice",
				e: {
					k: "iface",
					t: "ArithmExpr"
				}
			}]
		]
	},
	CaseClause: {
		node: true,
		fields: [
			["case", { k: "pos" }],
			["in", { k: "pos" }],
			["esac", { k: "pos" }],
			["braces", { k: "bool" }],
			["word", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["items", {
				k: "slice",
				e: {
					k: "ref",
					t: "CaseItem",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	CaseItem: {
		node: true,
		fields: [
			["op", { k: "uint" }],
			["opPos", { k: "pos" }],
			["comments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}],
			["patterns", {
				k: "slice",
				e: {
					k: "ref",
					t: "Word",
					n: true
				}
			}],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	TestClause: {
		node: true,
		fields: [
			["left", { k: "pos" }],
			["right", { k: "pos" }],
			["x", {
				k: "iface",
				t: "TestExpr"
			}]
		]
	},
	BinaryTest: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["x", {
				k: "iface",
				t: "TestExpr"
			}],
			["y", {
				k: "iface",
				t: "TestExpr"
			}]
		]
	},
	UnaryTest: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["x", {
				k: "iface",
				t: "TestExpr"
			}]
		]
	},
	ParenTest: {
		node: true,
		fields: [
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["x", {
				k: "iface",
				t: "TestExpr"
			}]
		]
	},
	DeclClause: {
		node: true,
		fields: [
			["variant", {
				k: "ref",
				t: "Lit",
				n: true
			}],
			["args", {
				k: "slice",
				e: {
					k: "ref",
					t: "Assign",
					n: true
				}
			}],
			["assigns", {
				k: "slice",
				e: {
					k: "ref",
					t: "Assign",
					n: true
				}
			}]
		]
	},
	ArrayExpr: {
		node: true,
		fields: [
			["lparen", { k: "pos" }],
			["rparen", { k: "pos" }],
			["elems", {
				k: "slice",
				e: {
					k: "ref",
					t: "ArrayElem",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	ArrayElem: {
		node: true,
		fields: [
			["index", {
				k: "iface",
				t: "ArithmExpr"
			}],
			["value", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["comments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	ExtGlob: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["op", { k: "uint" }],
			["pattern", {
				k: "ref",
				t: "Lit",
				n: true
			}]
		]
	},
	ProcSubst: {
		node: true,
		fields: [
			["opPos", { k: "pos" }],
			["rparen", { k: "pos" }],
			["op", { k: "uint" }],
			["stmts", {
				k: "slice",
				e: {
					k: "ref",
					t: "Stmt",
					n: true
				}
			}],
			["lastComments", {
				k: "slice",
				e: {
					k: "ref",
					t: "Comment",
					n: false
				}
			}]
		]
	},
	TimeClause: {
		node: true,
		fields: [
			["time", { k: "pos" }],
			["posixFormat", { k: "bool" }],
			["stmt", {
				k: "ref",
				t: "Stmt",
				n: true
			}]
		]
	},
	CoprocClause: {
		node: true,
		fields: [
			["coproc", { k: "pos" }],
			["name", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["stmt", {
				k: "ref",
				t: "Stmt",
				n: true
			}]
		]
	},
	LetClause: {
		node: true,
		fields: [["let", { k: "pos" }], ["exprs", {
			k: "slice",
			e: {
				k: "iface",
				t: "ArithmExpr"
			}
		}]]
	},
	BraceExp: {
		node: true,
		fields: [
			["lbrace", { k: "pos" }],
			["rbrace", { k: "pos" }],
			["sequence", { k: "bool" }],
			["elems", {
				k: "slice",
				e: {
					k: "ref",
					t: "Word",
					n: true
				}
			}]
		]
	},
	TestDecl: {
		node: true,
		fields: [
			["position", { k: "pos" }],
			["description", {
				k: "ref",
				t: "Word",
				n: true
			}],
			["body", {
				k: "ref",
				t: "Stmt",
				n: true
			}]
		]
	}
};
// src/wire.ts
/**
* Binary AST wire.
*
* Layout: LEB128 varints, a node id for the root and interface values, start/end offsets before
* each node body, presence bytes for nullable refs, and counts before slices. Non-node records have
* no type/start/end header. The authoritative field order is src/wire-schema.ts, generated from
* scripts/gen-ast/binary.go; the envelope lives in processor/result.go.
*/
const VARINT_BASE = 128;
const VARINT_MASK = 127;
const MAX_VARINT_BYTES = 8;
const encoder$1 = new TextEncoder();
const decoder$1 = new TextDecoder("utf-8", { ignoreBOM: true });
const NODE_TYPES = new Map(Object.entries(WIRE_TYPES).map(([name, id]) => [id, name]));
var Writer = class {
	constructor() {
		this.bytes = /* @__PURE__ */ new Uint8Array(1024);
		this.offset = 0;
	}
	ensure(size) {
		if (this.offset + size <= this.bytes.length) return;
		let length = this.bytes.length;
		while (length < this.offset + size) length *= 2;
		const next = new Uint8Array(length);
		next.set(this.bytes);
		this.bytes = next;
	}
	byte(value) {
		this.ensure(1);
		this.bytes[this.offset++] = value;
	}
	uint(value) {
		if (!Number.isSafeInteger(value) || value < 0) throw new InputError("wire integers must be non-negative safe integers");
		while (value >= VARINT_BASE) {
			this.byte(value & VARINT_MASK | VARINT_BASE);
			value = Math.floor(value / VARINT_BASE);
		}
		this.byte(value);
	}
	string(value) {
		const bytes = encoder$1.encode(value);
		this.uint(bytes.byteLength);
		this.ensure(bytes.byteLength);
		this.bytes.set(bytes, this.offset);
		this.offset += bytes.byteLength;
	}
	finish() {
		return this.bytes.slice(0, this.offset);
	}
};
var Reader = class {
	constructor(bytes) {
		this.position = 0;
		this.bytes = bytes;
	}
	get offset() {
		return this.position;
	}
	get length() {
		return this.bytes.length;
	}
	byte() {
		if (this.position >= this.bytes.length) throw new Error("truncated wire payload");
		return this.bytes[this.position++];
	}
	uint() {
		let value = 0;
		let shift = 1;
		for (let index = 0; index < MAX_VARINT_BYTES; index++) {
			const byte = this.byte();
			value += (byte & VARINT_MASK) * shift;
			if (!Number.isSafeInteger(value)) throw new TypeError("wire integer overflow");
			if (byte < VARINT_BASE) return value;
			shift *= VARINT_BASE;
		}
		throw new Error("invalid wire integer");
	}
	string() {
		const length = this.uint();
		if (length > this.bytes.length - this.position) throw new Error("truncated wire string");
		const value = decoder$1.decode(this.bytes.subarray(this.position, this.position + length));
		this.position += length;
		return value;
	}
	count() {
		const count = this.uint();
		/* istanbul ignore next -- malformed payload guard */
		if (count > this.bytes.length - this.position) throw new Error("wire count exceeds payload");
		return count;
	}
};
const writeNode = (writer, node, typeName) => {
	const schema = WIRE_SCHEMA[typeName];
	if (node == null || typeof node !== "object" || !schema?.node) throw new InputError(`wire expects a ${typeName} node`);
	const value = node;
	if (value.type !== typeName) throw new InputError(`wire expected ${typeName}, got ${String(value.type)}`);
	writer.uint(Number(value.start ?? 0));
	writer.uint(Number(value.end ?? 0));
	for (const [name, field] of schema.fields) writeField(writer, value[name], field);
};
const writeTyped = (writer, value, typeName) => {
	if (WIRE_SCHEMA[typeName]?.node) writeNode(writer, value, typeName);
	else {
		if (value == null || typeof value !== "object") throw new InputError(`wire expects a ${typeName} record`);
		const record = value;
		const fields = WIRE_SCHEMA[typeName].fields;
		for (const [name, field] of fields) writeField(writer, record[name], field);
	}
};
const writeField = (writer, value, field) => {
	switch (field.k) {
		case "string":
			writer.string(typeof value === "string" ? value : "");
			break;
		case "bool":
			writer.byte(value ? 1 : 0);
			break;
		case "uint":
			writer.uint(Number(value ?? 0));
			break;
		case "pos": {
			const position = value ?? {};
			writer.uint(Number(position.offset ?? 0));
			writer.uint(Number(position.line ?? 0));
			writer.uint(Number(position.column ?? 0));
			writer.byte(position.recovered ? 1 : 0);
			break;
		}
		case "ref":
			if (field.n) {
				if (value == null) {
					writer.byte(0);
					return;
				}
				writer.byte(1);
			}
			writeTyped(writer, value, field.t);
			break;
		case "iface": {
			if (value == null) {
				writer.uint(0);
				return;
			}
			const node = value;
			const id = WIRE_TYPES[node.type];
			if (!id) throw new InputError(`unknown wire node type: ${String(node.type)}`);
			writer.uint(id);
			writeNode(writer, value, node.type);
			break;
		}
		case "slice": {
			const items = Array.isArray(value) ? value : [];
			writer.uint(items.length);
			for (const item of items) writeField(writer, item, field.e);
			break;
		}
	}
};
const readNode = (reader, typeName) => {
	const schema = WIRE_SCHEMA[typeName];
	const node = {
		type: typeName,
		start: reader.uint(),
		end: reader.uint()
	};
	for (const [name, field] of schema.fields) node[name] = readField(reader, field);
	return node;
};
const readTyped = (reader, typeName) => {
	if (WIRE_SCHEMA[typeName]?.node) return readNode(reader, typeName);
	const record = {};
	const fields = WIRE_SCHEMA[typeName].fields;
	for (const [name, field] of fields) record[name] = readField(reader, field);
	return record;
};
const readField = (reader, field) => {
	switch (field.k) {
		case "string": return reader.string();
		case "bool": return reader.byte() !== 0;
		case "uint": return reader.uint();
		case "pos": {
			const offset = reader.uint();
			const line = reader.uint();
			const column = reader.uint();
			return reader.byte() !== 0 ? {
				offset,
				line,
				column,
				recovered: true
			} : {
				offset,
				line,
				column
			};
		}
		case "ref":
			if (field.n && reader.byte() === 0) return null;
			return readTyped(reader, field.t);
		case "iface": {
			const id = reader.uint();
			if (id === 0) return null;
			const typeName = NODE_TYPES.get(id);
			/* istanbul ignore next -- schema/id mismatch guard */
			if (!typeName) throw new Error(`unknown wire node id: ${id}`);
			return readNode(reader, typeName);
		}
		case "slice": {
			const count = reader.count();
			const items = [];
			for (let index = 0; index < count; index++) items.push(readField(reader, field.e));
			return items;
		}
	}
};
/** Encodes the current JS AST as the compact binary wire. */
const encodeAST = (ast) => {
	if (ast == null || !WIRE_SCHEMA[ast.type]?.node) throw new InputError("print(node) requires a syntax node");
	const writer = new Writer();
	writer.uint(WIRE_TYPES[ast.type]);
	writeNode(writer, ast, ast.type);
	return writer.finish();
};
/** Decodes a binary AST payload into plain JS objects. */
const decodeAST = (bytes) => {
	const reader = new Reader(bytes);
	const id = reader.uint();
	const typeName = NODE_TYPES.get(id);
	if (!typeName) throw new Error(`unknown wire node id: ${id}`);
	const node = readNode(reader, typeName);
	if (reader.offset !== reader.length) throw new Error("unexpected trailing wire data");
	return node;
};
// src/internal.ts
const MAX_STOP_AT_BYTES = 4;
const STOP_AT_OPTION_OFFSET = 16;
const RESULT_HEADER_BYTES = 4;
const supportedVariants = /* @__PURE__ */ new Set([
	LangVariant.LangBash,
	LangVariant.LangPOSIX,
	LangVariant.LangMirBSDKorn,
	LangVariant.LangBats,
	LangVariant.LangZsh
]);
let encoder;
let decoder;
const normalizeExports = (exports) => {
	const memory = exports.memory ?? exports.mem;
	return {
		...exports,
		memory
	};
};
const startGoRuntime = (go, instance) => {
	const exports = normalizeExports(instance.exports);
	if (!(exports.mem instanceof WebAssembly.Memory) || typeof exports.run !== "function") throw new TypeError("getProcessor requires a Go WASM instance");
	const run = go.run(instance);
	if (go.exited) {
		run.catch(() => void 0);
		throw new Error("Go runtime exited during startup");
	}
	return {
		go,
		exports,
		run
	};
};
const readResult = (memory, resultPointer, resultLength) => {
	const result = new Uint8Array(memory.buffer).subarray(resultPointer, resultPointer + resultLength);
	decoder ??= new TextDecoder();
	const metadataLength = new DataView(result.buffer, result.byteOffset, RESULT_HEADER_BYTES).getUint32(0, true);
	const metadata = JSON.parse(decoder.decode(result.subarray(RESULT_HEADER_BYTES, RESULT_HEADER_BYTES + metadataLength)));
	if (metadata.parseError) throw new ParseError(metadata.parseError);
	if (metadata.message) throw new ShSyntaxError(metadata.errorKind === "print" ? ErrorCode.Print : metadata.errorKind === "splitBraces" ? ErrorCode.SplitBraces : ErrorCode.Language, metadata.message);
	return {
		metadata,
		ast: result.subarray(RESULT_HEADER_BYTES + metadataLength)
	};
};
const writeOptions = ({ memory, wasmAlloc }, { keepComments = true, variant = LangVariant.LangBash, stopAt = "", recoverErrors = 0, useTabs = false, tabWidth = 2, simplify = false, indent = useTabs ? 0 : tabWidth, binaryNextLine = true, switchCaseIndent = true, spaceRedirects = true, keepPadding = false, minify = false, singleLine = false, functionNextLine = false }, printOutput) => {
	encoder ??= new TextEncoder();
	if (!supportedVariants.has(variant)) throw new InputError(`Unsupported shell variant: ${variant}`);
	const stopAtBytes = encoder.encode(stopAt);
	if (stopAtBytes.byteLength > MAX_STOP_AT_BYTES) throw new InputError("stopAt must be at most 4 bytes");
	const optionValues = [
		printOutput,
		keepComments,
		variant,
		recoverErrors,
		0,
		stopAtBytes.byteLength,
		simplify,
		indent,
		binaryNextLine,
		switchCaseIndent,
		spaceRedirects,
		keepPadding,
		minify,
		singleLine,
		functionNextLine
	];
	const optionsPointer = wasmAlloc(optionValues.length * Uint32Array.BYTES_PER_ELEMENT);
	const options = new DataView(memory.buffer, optionsPointer, optionValues.length * Uint32Array.BYTES_PER_ELEMENT);
	let optionOffset = 0;
	for (const value of optionValues) {
		options.setUint32(optionOffset, Number(value), true);
		optionOffset += Uint32Array.BYTES_PER_ELEMENT;
	}
	new Uint8Array(memory.buffer, optionsPointer + STOP_AT_OPTION_OFFSET, MAX_STOP_AT_BYTES).set(stopAtBytes);
	return optionsPointer;
};
const invoke = (exports, textOrAst, options = {}) => {
	const { memory, wasmAlloc, wasmFree, process, printNode, resultLength } = exports;
	const { filepath = "", print = false, originalText } = options;
	encoder ??= new TextEncoder();
	decoder ??= new TextDecoder();
	if (textOrAst == null || typeof textOrAst !== "string" && (typeof textOrAst !== "object" || Array.isArray(textOrAst))) throw new InputError("expected shell source text or a syntax tree");
	let text;
	let printOutput;
	let astBytes;
	if (typeof textOrAst === "string") {
		text = textOrAst;
		printOutput = print;
	} else if (originalText == null) {
		astBytes = encodeAST(textOrAst);
		text = "";
		printOutput = true;
	} else {
		text = originalText;
		printOutput = true;
	}
	const textBytes = encoder.encode(text);
	const optionsPointer = writeOptions(exports, options, printOutput);
	let filePathPointer = 0;
	let filePathLength = 0;
	if (!astBytes) {
		const filePath = encoder.encode(filepath);
		filePathLength = filePath.byteLength;
		filePathPointer = wasmAlloc(filePathLength);
		new Uint8Array(memory.buffer).set(filePath, filePathPointer);
	}
	const inputBytes = astBytes ?? textBytes;
	const textPointer = wasmAlloc(inputBytes.byteLength);
	new Uint8Array(memory.buffer).set(inputBytes, textPointer);
	const resultPointer = astBytes ? printNode(textPointer, astBytes.byteLength, optionsPointer) : process(filePathPointer, filePathLength, textPointer, textBytes.byteLength, optionsPointer);
	if (!astBytes) wasmFree(filePathPointer);
	wasmFree(textPointer);
	wasmFree(optionsPointer);
	const { metadata, ast } = readResult(memory, resultPointer, resultLength());
	return printOutput ? metadata.text : decodeAST(ast);
};
const invokeSplitBraces = ({ memory, wasmAlloc, wasmFree, splitBraces, resultLength }, word) => {
	const bytes = encodeAST(word);
	const start = word.start;
	const end = word.end;
	const nodePointer = wasmAlloc(bytes.byteLength);
	new Uint8Array(memory.buffer).set(bytes, nodePointer);
	const resultPointer = splitBraces(nodePointer, bytes.byteLength);
	wasmFree(nodePointer);
	const { metadata, ast } = readResult(memory, resultPointer, resultLength());
	const result = decodeAST(ast);
	result.start = start;
	result.end = end;
	return {
		word: result,
		changed: metadata.changed === true
	};
};
const invokeInteractive = (exports, text, options) => {
	const { memory, wasmAlloc, wasmFree, interactive, resultLength } = exports;
	const { filepath = "" } = options;
	encoder ??= new TextEncoder();
	decoder ??= new TextDecoder();
	const textBytes = encoder.encode(text);
	const filePathBytes = encoder.encode(filepath);
	const optionsPointer = writeOptions(exports, options, false);
	const filePathPointer = wasmAlloc(filePathBytes.byteLength);
	new Uint8Array(memory.buffer).set(filePathBytes, filePathPointer);
	const textPointer = wasmAlloc(textBytes.byteLength);
	new Uint8Array(memory.buffer).set(textBytes, textPointer);
	const resultPointer = interactive(filePathPointer, filePathBytes.byteLength, textPointer, textBytes.byteLength, optionsPointer);
	wasmFree(filePathPointer);
	wasmFree(textPointer);
	wasmFree(optionsPointer);
	const { metadata, ast } = readResult(memory, resultPointer, resultLength());
	const interactiveResult = metadata.interactive;
	return {
		ast: decodeAST(ast),
		incomplete: interactiveResult.incomplete,
		remaining: interactiveResult.remaining
	};
};
Object.defineProperty(exports, "BinAritOperator", {
	enumerable: true,
	get: function() {
		return BinAritOperator;
	}
});
Object.defineProperty(exports, "BinCmdOperator", {
	enumerable: true,
	get: function() {
		return BinCmdOperator;
	}
});
Object.defineProperty(exports, "BinTestOperator", {
	enumerable: true,
	get: function() {
		return BinTestOperator;
	}
});
Object.defineProperty(exports, "CaseOperator", {
	enumerable: true,
	get: function() {
		return CaseOperator;
	}
});
Object.defineProperty(exports, "ErrorCode", {
	enumerable: true,
	get: function() {
		return ErrorCode;
	}
});
Object.defineProperty(exports, "GlobOperator", {
	enumerable: true,
	get: function() {
		return GlobOperator;
	}
});
Object.defineProperty(exports, "InputError", {
	enumerable: true,
	get: function() {
		return InputError;
	}
});
Object.defineProperty(exports, "LangVariant", {
	enumerable: true,
	get: function() {
		return LangVariant;
	}
});
Object.defineProperty(exports, "ParExpOperator", {
	enumerable: true,
	get: function() {
		return ParExpOperator;
	}
});
Object.defineProperty(exports, "ParNamesOperator", {
	enumerable: true,
	get: function() {
		return ParNamesOperator;
	}
});
Object.defineProperty(exports, "ParseError", {
	enumerable: true,
	get: function() {
		return ParseError;
	}
});
Object.defineProperty(exports, "ProcOperator", {
	enumerable: true,
	get: function() {
		return ProcOperator;
	}
});
Object.defineProperty(exports, "RedirOperator", {
	enumerable: true,
	get: function() {
		return RedirOperator;
	}
});
Object.defineProperty(exports, "ShSyntaxError", {
	enumerable: true,
	get: function() {
		return ShSyntaxError;
	}
});
Object.defineProperty(exports, "UnAritOperator", {
	enumerable: true,
	get: function() {
		return UnAritOperator;
	}
});
Object.defineProperty(exports, "UnTestOperator", {
	enumerable: true,
	get: function() {
		return UnTestOperator;
	}
});
Object.defineProperty(exports, "__toESM", {
	enumerable: true,
	get: function() {
		return __toESM;
	}
});
Object.defineProperty(exports, "createSourceIndex", {
	enumerable: true,
	get: function() {
		return createSourceIndex;
	}
});
Object.defineProperty(exports, "invoke", {
	enumerable: true,
	get: function() {
		return invoke;
	}
});
Object.defineProperty(exports, "invokeInteractive", {
	enumerable: true,
	get: function() {
		return invokeInteractive;
	}
});
Object.defineProperty(exports, "invokeSplitBraces", {
	enumerable: true,
	get: function() {
		return invokeSplitBraces;
	}
});
Object.defineProperty(exports, "isIncomplete", {
	enumerable: true,
	get: function() {
		return isIncomplete;
	}
});
Object.defineProperty(exports, "startGoRuntime", {
	enumerable: true,
	get: function() {
		return startGoRuntime;
	}
});
Object.defineProperty(exports, "walk", {
	enumerable: true,
	get: function() {
		return walk;
	}
});
