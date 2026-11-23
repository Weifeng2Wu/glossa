import { readFile } from "node:fs/promises";
import path from "node:path";
import { root, tauriDirectory } from "./desktop-runtime.mjs";

export async function configureUpdateSigning(environment = process.env, directory = root) {
  // Pull requests cannot access release secrets and must not produce signed update artifacts.
  if (environment.GLOSSA_UNSIGNED_BUILD === "1") {
    delete environment.GLOSSA_UPDATER_PUBLIC_KEY;
    return;
  }
  const config = JSON.parse(await readFile(path.join(tauriDirectory, "tauri.conf.json"), "utf8"));
  const publicKey =
    environment.GLOSSA_UPDATER_PUBLIC_KEY?.trim() || config.plugins.updater.pubkey.trim();
  if (!publicKey) return;
  environment.GLOSSA_UPDATER_PUBLIC_KEY = publicKey;
  if (!environment.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    try {
      const filename = path.join(directory, ".glossa-signing/updater.key");
      const localPublicKey = (await readFile(`${filename}.pub`, "utf8")).trim();
      if (localPublicKey !== publicKey)
        throw new Error("Local updater key does not match the configured public key.");
      environment.TAURI_SIGNING_PRIVATE_KEY = (await readFile(filename, "utf8")).trim();
      environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw new Error(
        "Signed update builds require TAURI_SIGNING_PRIVATE_KEY or the local .glossa-signing/updater.key. Restore the existing key; do not generate a replacement for published clients.",
      );
    }
  }
}
