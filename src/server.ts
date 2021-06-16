/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import { parse, ParsedUrlQuery } from 'querystring';
import * as url from 'url';
import { portADFS, redirectUrlAAD } from './constants';

interface Deferred<T> {
	resolve: (result: T | Promise<T>) => void;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reject: (reason: any) => void;
}

export async function checkRedirectServer(adfs: boolean): Promise<boolean> {
	if (adfs) {
		return true;
	}
	let timer: NodeJS.Timer | undefined;
	const promise = new Promise<boolean>(resolve => {
		const req = https.get({
			...url.parse(`${redirectUrlAAD}?state=3333,cccc`),
		}, res => {
			const key = Object.keys(res.headers)
				.find(key => key.toLowerCase() === 'location');
			const location = key && res.headers[key]
			resolve(res.statusCode === 302 && typeof location === 'string' && location.startsWith('http://127.0.0.1:3333/callback'));
		});
		req.on('error', err => {
			console.error(err);
			resolve(false);
		});
		req.on('close', () => {
			resolve(false);
		});
		timer = setTimeout(() => {
			resolve(false);
			req.abort();
		}, 5000);
	});
	function cancelTimer() {
		if (timer) {
			clearTimeout(timer);
		}
	}
	promise.then(cancelTimer, cancelTimer);
	return promise;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createServer(nonce: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type RedirectResult = { req: http.IncomingMessage, res: http.ServerResponse } | { err: any; res: http.ServerResponse; };
	let deferredRedirect: Deferred<RedirectResult>;
	const redirectPromise = new Promise<RedirectResult>((resolve, reject) => deferredRedirect = { resolve, reject });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type CodeResult = { code: string; res: http.ServerResponse; } | { err: any; res: http.ServerResponse; };
	let deferredCode: Deferred<CodeResult>;
	const codePromise = new Promise<CodeResult>((resolve, reject) => deferredCode = { resolve, reject });

	const codeTimer = setTimeout(() => {
		deferredCode.reject(new Error('Timeout waiting for code'));
	}, 5 * 60 * 1000);
	function cancelCodeTimer() {
		clearTimeout(codeTimer);
	}
	const server = http.createServer(function (req, res) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const reqUrl = url.parse(req.url!, /* parseQueryString */ true);
		switch (reqUrl.pathname) {
			case '/signin':
				const receivedNonce = (reqUrl.query.nonce.toString() || '').replace(/ /g, '+');
				if (receivedNonce === nonce) {
					deferredRedirect.resolve({ req, res });
				} else {
					const err = new Error('Nonce does not match.');
					deferredRedirect.resolve({ err, res });
				}
				break;
			case '/':
				sendFile(res, path.join(__dirname, '../codeFlowResult/index.html'), 'text/html; charset=utf-8');
				break;
			case '/main.css':
				sendFile(res, path.join(__dirname, '../codeFlowResult/main.css'), 'text/css; charset=utf-8');
				break;
			case '/callback':
				deferredCode.resolve(callback(nonce, reqUrl)
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
					.then(code => ({ code, res }), err => ({ err, res })));
				break;
			default:
				res.writeHead(404);
				res.end();
				break;
		}
	});
	codePromise.then(cancelCodeTimer, cancelCodeTimer);
	return {
		server,
		redirectPromise,
		codePromise
	};
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createTerminateServer(server: http.Server) {
	const sockets: Record<number, net.Socket> = {};
	let socketCount = 0;
	server.on('connection', socket => {
		const id = socketCount++;
		sockets[id] = socket;
		socket.on('close', () => {
			delete sockets[id];
		});
	});
	return async () => {
		const result = new Promise<void>((resolve: () => void) => server.close(resolve));
		for (const id in sockets) {
			sockets[id].destroy();
		}
		return result;
	};
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function startServer(server: http.Server, adfs: boolean) {
	let portTimer: NodeJS.Timer;
	function cancelPortTimer() {
		clearTimeout(portTimer);
	}
	const port = new Promise<number>((resolve, reject) => {
		portTimer = setTimeout(() => {
			reject(new Error('Timeout waiting for port'));
		}, 5000);
		server.on('listening', () => {
			const address: string | net.AddressInfo | null = server.address();
			if (address && typeof address !== 'string') {
				resolve(address.port);
			}
		});
		server.on('error', err => {
			reject(err);
		});
		server.on('close', () => {
			reject(new Error('Closed'));
		});
		server.listen(adfs ? portADFS : 0, '127.0.0.1');
	});
	port.then(cancelPortTimer, cancelPortTimer);
	return port;
}

function sendFile(res: http.ServerResponse, filepath: string, contentType: string) {
	fs.readFile(filepath, (err, body) => {
		if (err) {
			console.error(err);
		} else {
			res.writeHead(200, {
				'Content-Length': body.length,
				'Content-Type': contentType
			});
			res.end(body);
		}
	});
}

async function callback(nonce: string, reqUrl: url.Url): Promise<string> {
	let query: ParsedUrlQuery;
	let error: string | undefined;
	let code: string | undefined;

	if (reqUrl.query) {
		query = typeof reqUrl.query === 'string' ? parse(reqUrl.query) : reqUrl.query;
		error = getQueryProp(query, 'error_description') || getQueryProp(query, 'error');
		code = getQueryProp(query, 'code');

		if (!error) {
			const state: string = getQueryProp(query, 'state');
			const receivedNonce: string = (state?.split(',')[1] || '').replace(/ /g, '+');

			if (receivedNonce !== nonce) {
				error = 'Nonce does not match.';
			}
		}
	}

	if (!error && code) {
		return code;
	}

	throw new Error(error || 'No code received.');
}

function getQueryProp(query: ParsedUrlQuery, propName: string): string {
	const value = query[propName];
	return typeof value === 'string' ? value : '';
}