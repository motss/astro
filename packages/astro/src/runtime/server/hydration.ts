import type {
	AstroComponentMetadata,
	SSRElement,
	SSRLoadedRenderer,
	SSRResult,
} from '../../@types/astro.js';
import { AstroError, AstroErrorData } from '../../core/errors/index.js';
import { escapeHTML } from './escape.js';
import { serializeProps } from './serialize.js';
import { isNullish, isObject } from './util.js';

export interface HydrationMetadata {
	directive: string;
	value: string;
	componentUrl: string;
	componentExport: { value: string };
}

type Props = Record<string | number | symbol, any>;

interface ExtractedProps {
	isPage: boolean;
	hydration: HydrationMetadata | null;
	props: Props;
	propsWithoutTransitionAttributes: Props;
}

const transitionDirectivesToCopyOnIsland = Object.freeze([
	'data-astro-transition-scope',
	'data-astro-transition-persist',
]);

// Used to extract the directives, aka `client:load` information about a component.
// Finds these special props and removes them from what gets passed into the component.
export function extractDirectives(
	inputProps: Props,
	clientDirectives: SSRResult['clientDirectives']
): ExtractedProps {
	// console.log({ inputProps });
	let extracted: ExtractedProps = {
		isPage: false,
		hydration: null,
		props: {},
		propsWithoutTransitionAttributes: {},
	};
	for (let [key, value] of Object.entries(inputProps)) {
		if (key.startsWith('server:')) {
			if (key === 'server:root') {
				extracted.isPage = true;
			}
		}
		if (key.startsWith('client:')) {
			if (!extracted.hydration) {
				extracted.hydration = {
					directive: '',
					value: '',
					componentUrl: '',
					componentExport: { value: '' },
				};
			}
			switch (key) {
				case 'client:component-path': {
					extracted.hydration.componentUrl = value;
					break;
				}
				case 'client:component-export': {
					extracted.hydration.componentExport.value = value;
					break;
				}
				// This is a special prop added to prove that the client hydration method
				// was added statically.
				case 'client:component-hydration': {
					break;
				}
				case 'client:display-name': {
					break;
				}
				case 'client:params': {
					// this is just a transform step transforms that turn `client:params` into
					// standard cliend directives
					const maybeDirectiveOptions = value;

					// skip the transform if the value is nullish
					if (isNullish(maybeDirectiveOptions)) {
						break;
					}

					if (!isObject(maybeDirectiveOptions)) {
						throw new Error(
							`Error: invalid \`params\` directive value ${JSON.stringify(
								maybeDirectiveOptions
							)}. Expected an object of the form \`{ directive: string, value: string }\`, but got ${typeof maybeDirectiveOptions}.`
						);
					}

					// validate the object shape
					// it should only have two keys: `directive` and `value` (which is optional)
					for (let _key of Object.keys(maybeDirectiveOptions)) {
						if (_key !== 'directive' && _key !== 'value') {
							throw new Error(
								`Error: invalid \`params\` directive value. Expected an object of the form \`{ directive: string, value: string }\`, but got ${JSON.stringify(
									maybeDirectiveOptions
								)}.`
							);
						}
					}

					if (typeof maybeDirectiveOptions.directive !== 'string') {
						throw new Error(
							`Error: expected \`directive\` to be a string, but got ${typeof maybeDirectiveOptions.directive}.`
						);
					}

					key = `client:${maybeDirectiveOptions.directive}`;
					value = maybeDirectiveOptions.value;
					// intentionally fall-through to the next case
				}

				default: {
					extracted.hydration.directive = key.split(':')[1];
					extracted.hydration.value = value;

					// console.log({ hydration: extracted.hydration });

					// throw an error if an invalid hydration directive was provided
					if (!clientDirectives.has(extracted.hydration.directive)) {
						const hydrationMethods = Array.from(clientDirectives.keys())
							.map((d) => `client:${d}`)
							.join(', ');
						throw new Error(
							`Error: invalid hydration directive "${key}". Supported hydration methods: ${hydrationMethods}`
						);
					}

					// throw an error if the query wasn't provided for client:media
					if (
						extracted.hydration.directive === 'media' &&
						typeof extracted.hydration.value !== 'string'
					) {
						throw new AstroError(AstroErrorData.MissingMediaQueryDirective);
					}

					break;
				}
			}
		} else {
			extracted.props[key] = value;
			if (!transitionDirectivesToCopyOnIsland.includes(key)) {
				extracted.propsWithoutTransitionAttributes[key] = value;
			}
		}
	}
	for (const sym of Object.getOwnPropertySymbols(inputProps)) {
		extracted.props[sym] = inputProps[sym];
		extracted.propsWithoutTransitionAttributes[sym] = inputProps[sym];
	}

	return extracted;
}

interface HydrateScriptOptions {
	renderer: SSRLoadedRenderer;
	result: SSRResult;
	astroId: string;
	props: Record<string | number, any>;
	attrs: Record<string, string> | undefined;
}

/** For hydrated components, generate a <script type="module"> to load the component */
export async function generateHydrateScript(
	scriptOptions: HydrateScriptOptions,
	metadata: Required<AstroComponentMetadata>
): Promise<SSRElement> {
	const { renderer, result, astroId, props, attrs } = scriptOptions;
	const { hydrate, componentUrl, componentExport } = metadata;

	if (!componentExport.value) {
		throw new AstroError({
			...AstroErrorData.NoMatchingImport,
			message: AstroErrorData.NoMatchingImport.message(metadata.displayName),
		});
	}

	const island: SSRElement = {
		children: '',
		props: {
			// This is for HMR, probably can avoid it in prod
			uid: astroId,
		},
	};

	// Attach renderer-provided attributes
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			island.props[key] = escapeHTML(value);
		}
	}

	// Add component url
	island.props['component-url'] = await result.resolve(decodeURI(componentUrl));

	// Add renderer url
	if (renderer.clientEntrypoint) {
		island.props['component-export'] = componentExport.value;
		island.props['renderer-url'] = await result.resolve(decodeURI(renderer.clientEntrypoint));
		island.props['props'] = escapeHTML(serializeProps(props, metadata));
	}

	island.props['ssr'] = '';
	island.props['client'] = hydrate;
	let beforeHydrationUrl = await result.resolve('astro:scripts/before-hydration.js');
	if (beforeHydrationUrl.length) {
		island.props['before-hydration-url'] = beforeHydrationUrl;
	}
	island.props['opts'] = escapeHTML(
		JSON.stringify({
			name: metadata.displayName,
			value: metadata.hydrateArgs || '',
		})
	);

	transitionDirectivesToCopyOnIsland.forEach((name) => {
		if (props[name]) {
			island.props[name] = props[name];
		}
	});

	return island;
}
