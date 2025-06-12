// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useStore } from '@nanostores/react';
import { dAppKit } from './dApp-kit.js';

function App() {
	const wallets = useStore(dAppKit.stores.$wallets);

	return (
		<div>
			<mysten-dapp-kit-connect-button></mysten-dapp-kit-connect-button>
			<p>TODO: Flesh this out more / make it more use case specific ^.^</p>
			{wallets.length > 0 ? (
				<ul>
					{wallets.map((wallet) => (
						<li key={wallet.name}>{wallet.name}</li>
					))}
				</ul>
			) : (
				<p>No registered wallets</p>
			)}
		</div>
	);
}

export default App;
