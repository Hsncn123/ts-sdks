// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css } from 'lit';
import { sharedStyles } from '../styles/index.js';

export const styles = [
	sharedStyles,
	css`
		ul {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.no-wallets-container {
			display: flex;
			justify-content: center;
			align-items: center;
		}
	`,
];
