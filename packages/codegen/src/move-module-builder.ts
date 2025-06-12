// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FileBuilder } from './file-builder.js';
import { readFile } from 'node:fs/promises';
import { deserialize } from '@mysten/move-bytecode-template';
import { getSafeName, renderTypeSignature, SUI_FRAMEWORK_ADDRESS } from './render-types.js';
import { mapToObject, parseTS } from './utils.js';
import type { ModuleSummary, Type } from './types/summary.js';
import { summaryFromDeserializedModule } from './summary.js';
import type { DeserializedModule } from './types/deserialized.js';
import { join } from 'node:path';

export class MoveModuleBuilder extends FileBuilder {
	summary: ModuleSummary;
	#depsDir = './';
	#addressMappings: Record<string, string>;

	constructor({
		summary,
		addressMappings = {},
	}: {
		summary: ModuleSummary;
		addressMappings?: Record<string, string>;
	}) {
		super();
		this.summary = summary;
		this.#addressMappings = addressMappings;
	}

	static async fromBytecodeFile(file: string) {
		const bytes = await readFile(file);
		const deserialized: DeserializedModule = deserialize(bytes);

		const builder = new MoveModuleBuilder({
			summary: summaryFromDeserializedModule(deserialized),
		});

		builder.#depsDir = './deps';

		return builder;
	}

	static async fromSummaryFile(file: string, addressMappings: Record<string, string>) {
		const summary = JSON.parse(await readFile(file, 'utf-8'));

		return new MoveModuleBuilder({
			summary,
			addressMappings,
		});
	}

	#resolveAddress(address: string) {
		return this.#addressMappings[address] ?? address;
	}

	renderBCSTypes() {
		this.addImport('@mysten/sui/bcs', 'bcs');
		this.renderStructs();
		this.renderEnums();
	}

	hasBcsTypes() {
		return (
			Object.keys(this.summary.structs).length > 0 || Object.keys(this.summary.enums).length > 0
		);
	}

	hasFunctions() {
		return Object.values(this.summary.functions).some(
			(func) => func.visibility === 'Public' && !func.macro_,
		);
	}

	hasTypesOrFunctions() {
		return this.hasBcsTypes() || this.hasFunctions();
	}

	renderStructs() {
		for (const [name, struct] of Object.entries(this.summary.structs)) {
			this.exports.push(name);

			const fields = Object.entries(struct.fields.fields);
			const fieldObject = mapToObject(fields, ([name, field]) => [
				name,
				renderTypeSignature(field.type_, {
					format: 'bcs',
					summary: this.summary,
					typeParameters: struct.type_parameters,
					resolveAddress: (address) => this.#resolveAddress(address),
					onDependency: (address, mod) =>
						this.addStarImport(
							address === this.summary.id.address
								? `./${mod}.js`
								: join(`~root`, this.#depsDir, `${address}/${mod}.js`),
							mod,
						),
				}),
			]);

			const params = struct.type_parameters.filter((param) => !param.phantom);

			if (params.length === 0) {
				this.statements.push(
					...parseTS/* ts */ `export function ${name}() {
						return bcs.struct('${name}', ${fieldObject})
					}`,
				);
			} else {
				this.addImport('@mysten/sui/bcs', 'type BcsType');

				const typeParams = `...typeParameters: [${params.map((param, i) => param.name ?? `T${i}`).join(', ')}]`;
				const typeGenerics = `${params.map((param, i) => `${param.name ?? `T${i}`} extends BcsType<any>`).join(', ')}`;

				this.statements.push(
					...parseTS/* ts */ `export function ${name}<${typeGenerics}>(${typeParams}) {
						return bcs.struct('${name}', ${fieldObject})
					}`,
				);
			}
		}
	}

	renderEnums() {
		for (const [name, enumDef] of Object.entries(this.summary.enums)) {
			this.exports.push(name);

			const variants = Object.entries(enumDef.variants).map(([variantName, variant]) => ({
				name: variantName,
				fields: Object.entries(variant.fields.fields).map(([fieldName, field]) => ({
					name: fieldName,
					signature: renderTypeSignature(field.type_, {
						format: 'bcs',
						summary: this.summary,
						typeParameters: enumDef.type_parameters,
						resolveAddress: (address) => this.#resolveAddress(address),
						onDependency: (address, mod) =>
							this.addStarImport(
								address === this.summary.id.address
									? `./${mod}.js`
									: `~root/deps/${address}/${mod}.js`,
								mod,
							),
					}),
				})),
			}));

			const variantsObject = mapToObject(variants, (variant) => [
				variant.name,
				variant.fields.length === 0
					? 'null'
					: variant.fields.length === 1
						? variant.fields[0].signature
						: `bcs.tuple([${variant.fields.map((field) => field.signature).join(', ')}])`,
			]);

			const params = enumDef.type_parameters.filter((param) => !param.phantom);

			if (params.length === 0) {
				this.statements.push(
					...parseTS/* ts */ `
					export function ${name}( ) {
						return bcs.enum('${name}', ${variantsObject})
					}`,
				);
			} else {
				this.addImport('@mysten/sui/bcs', 'type BcsType');

				const typeParams = `...typeParameters: [${params.map((param, i) => param.name ?? `T${i}`).join(', ')}]`;
				const typeGenerics = `${params.map((param, i) => `${param.name ?? `T${i}`} extends BcsType<any>`).join(', ')}`;

				this.statements.push(
					...parseTS/* ts */ `
					export function ${name}<${typeGenerics}>(${typeParams}) {
						return bcs.enum('${name}', ${variantsObject})
					}`,
				);
			}
		}
	}

	renderFunctions() {
		const statements = [];
		const names = [];

		if (!this.hasFunctions()) {
			return;
		}
		this.addImport('@mysten/sui/transactions', 'type Transaction');

		for (const [name, func] of Object.entries(this.summary.functions)) {
			if (func.visibility !== 'Public' || func.macro_) {
				continue;
			}

			const parameters = func.parameters.filter((param) => !this.isContextReference(param.type_));
			const fnName = getSafeName(name);

			this.addImport('~root/utils/index.js', 'normalizeMoveArguments');
			this.addImport('~root/utils/index.js', 'type RawTransactionArgument');

			names.push(fnName);

			const usedTypeParameters = new Set<number | string>();

			const argumentsTypes = parameters
				.map((param) =>
					renderTypeSignature(param.type_, {
						format: 'typescriptArg',
						summary: this.summary,
						typeParameters: func.type_parameters,
						resolveAddress: (address) => this.#resolveAddress(address),
						onTypeParameter: (typeParameter) => usedTypeParameters.add(typeParameter),
					}),
				)
				.map((type) => `RawTransactionArgument<${type}>`)
				.join(',\n');

			if (usedTypeParameters.size > 0) {
				this.addImport('@mysten/sui/bcs', 'type BcsType');
			}

			statements.push(
				...parseTS/* ts */ `function
					${fnName}${
						usedTypeParameters.size > 0
							? `<
							${func.type_parameters.map((param, i) => `${param.name ?? `T${i}`} extends BcsType<any>`)}
						>`
							: ''
					}(options: {
						arguments: [
						${argumentsTypes}],

						${
							func.type_parameters.length
								? `typeArguments: [${func.type_parameters.map(() => 'string').join(', ')}]`
								: ''
						}
				}) {
					const argumentsTypes = [
						${parameters
							.map((param) =>
								renderTypeSignature(param.type_, {
									format: 'typeTag',
									summary: this.summary,
									typeParameters: func.type_parameters,
									resolveAddress: (address) => this.#resolveAddress(address),
								}),
							)
							.map((tag) => (tag.includes('{') ? `\`${tag}\`` : `'${tag}'`))
							.join(',\n')}
					]
					return (tx: Transaction) => tx.moveCall({
						package: packageAddress,
						module: '${this.summary.id.name}',
						function: '${name}',
						arguments: normalizeMoveArguments(options.arguments, argumentsTypes),
						${func.type_parameters.length ? 'typeArguments: options.typeArguments' : ''}
					})
				}`,
			);
		}

		this.statements.push(
			...parseTS/* ts */ `
			export function init(packageAddress: string) {
				${statements}

				return { ${names.join(', ')} }
			}`,
		);
	}

	isContextReference(type: Type): boolean {
		if (typeof type === 'string') {
			return false;
		}

		if ('Reference' in type) {
			return this.isContextReference(type.Reference[1]);
		}

		if ('Datatype' in type) {
			return this.#resolveAddress(type.Datatype.module.address) === SUI_FRAMEWORK_ADDRESS;
		}

		return false;
	}
}
