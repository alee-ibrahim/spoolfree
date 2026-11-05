/**
 * pnpm keygen
 *
 * Generates the Ed25519 manifest signing key and a random enrollment token.
 * Prints them to stdout only; store them in your secret manager, never in git.
 *   --env   print in .env format (for local development)
 */
import { generateSeed, keyId, randomToken } from "../src/lib/crypto/signing";

const { seed, publicKey } = generateSeed();
const enrollment = randomToken(32);
const id = keyId(Buffer.from(publicKey, "base64"));

if (process.argv.includes("--env")) {
  console.log(`MANIFEST_SIGNING_KEY=${seed}`);
  console.log(`AGENT_ENROLLMENT_TOKEN=${enrollment}`);
  console.log(`# Agent public key (pin with -PublicKey): ${publicKey}  keyId=${id}`);
} else {
  console.log("Spoolfree keys (keep the first two secret)\n");
  console.log(`MANIFEST_SIGNING_KEY   ${seed}`);
  console.log(`AGENT_ENROLLMENT_TOKEN ${enrollment}`);
  console.log("");
  console.log(`Public key for Install-SpoolfreeAgent.ps1 -PublicKey: ${publicKey}`);
  console.log(`Key ID: ${id}`);
  console.log("\nWrite AGENT_ENROLLMENT_TOKEN to the token file on your restricted share (see docs/deployment.md).");
}
