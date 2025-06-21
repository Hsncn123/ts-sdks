// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { css } from 'lit';
import { sharedStyles } from '../styles/index.js';
import { iconButtonStyles } from '../styles/icon-button.js';

export const styles = [
	sharedStyles,
	iconButtonStyles,
	css`
		:host {
			display: block;
			width: fit-content;
		}

		.menu {
			display: none;
		}

		[aria-expanded='true'] + .menu {
			display: flex;
			flex-direction: column;
			max-width: fit-content;
			min-width: 396px;
			gap: 16px;
			padding: 16px;
			position: absolute;
			outline: none;
			background-color: var(--dapp-kit-popover);
			color: var(--dapp-kit-popover-foreground);
			border-radius: var(--dapp-kit-radius-lg);
			border: 1px solid var(--dapp-kit-border);
			box-shadow:
				0 4px 6px -1px rgba(0, 0, 0, 0.1),
				0 2px 4px -2px rgba(0, 0, 0, 0.1);
		}

		.header-container {
			display: flex;
			align-items: center;
			justify-content: space-between;
		}

		.header-title {
			font-size: 18px;
			font-weight: var(--dapp-kit-font-weight-semibold);
			letter-spacing: -0.18px;
		}

		img {
			width: 24px;
			height: 24px;
			border-radius: 96px;
		}

		[aria-expanded='true'] .chevron {
			transition: transform 0.3s ease;
			transform: rotate(180deg);
		}

		.chevron {
			display: flex;
		}

		.chevron svg {
			width: 12px;
			height: 12px;
		}

		.trigger-content {
			display: flex;
			align-items: center;
			font-weight: var(--dapp-kit-font-weight-semibold);
			gap: 12px;
		}

		.accounts-list {
			display: flex;
			flex-direction: column;
			gap: 12px;
			max-height: 240px;
			overflow-y: auto;
		}

		.disconnect-button {
			background-color: rgba(0, 0, 0, 0.8);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 100%;
			border-radius: var(--dapp-kit-radius-md);
			height: 48px;
			padding: 16px;
			gap: 8px;
		}

		.container {
			padding-top: 12px;
			padding-bottom: 12px;
			padding-left: 16px;
			padding-right: 16px;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			width: 100%;
			border-radius: var(--dapp-kit-radius-sm);
		}

		.container[data-checked='true'] {
			background-color: var(--dapp-kit-accent);
		}

		.account-title {
			font-weight: var(--dapp-kit-font-weight-medium);
		}

		.account-subtitle {
			color: var(--dapp-kit-muted-foreground);
		}

		.account-info {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		.content {
			display: flex;
			flex-grow: 1;
			gap: 12px;
		}

		.copy-address-button {
			display: inline-flex;
		}

		.copy-address-button svg {
			width: 16px;
			height: 16px;
		}

		.radio-indicator {
			width: 20px;
			height: 20px;
			border-radius: 100%;
			background-color: var(--dapp-kit-input);
			border: 1px solid var(--dapp-kit-border);
			display: inline-flex;
			justify-content: center;
			align-items: center;
		}

		.content:focus-visible .radio-indicator {
			border-color: hsl(var(--dapp-kit-ring));
			box-shadow: 0 0 0 3px hsl(var(--dapp-kit-ring) / 0.5);
			outline: none;
		}

		[data-checked='true'] .radio-indicator {
			color: var(--dapp-kit-positive);
			border-color: var(--dapp-kit-positive);
		}

		.radio-input {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border-width: 0;
		}
	`,
];
