"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateVerifier = updateVerifier;
/**
 * Updates or clears the attached verifier address for a pending task.
 * Restricted strictly to `Pending` status tasks — attempts against claimed or completed tasks
 * reject with `KeeperErrorCode.InvalidTaskStatus`.
 *
 * @param client The KeeperRegistryClient instance
 * @param params { owner, taskId, verifier? } (verifier: undefined clears the verifier)
 * @param options Building options
 */
async function updateVerifier(client, params, options) {
    return client.updateVerifier(params, options);
}
//# sourceMappingURL=updateVerifier.js.map