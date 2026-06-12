This project intentionally avoids CI-based npm publishing because GitHub workflow authority is part of the
supply-chain threat model: a compromised workflow dispatch/ref checkout could
publish malicious packages if CI has publish credentials or trusted-publishing
authority. Keep npm publishing manual/local. The preferred simple path is a
package script that runs `npm login && npm publish --access public`.
