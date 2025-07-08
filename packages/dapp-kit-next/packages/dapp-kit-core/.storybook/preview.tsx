// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Preview } from '@storybook/web-components';

import '../src/ui/dapp-kit-connect-button.js';
import '../src/ui/dapp-kit-connect-modal.js';

const preview: Preview = {
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		docs: {
			story: {
				inline: false,
				iframeHeight: 600,
			},
		},
	},
};

export default preview;
