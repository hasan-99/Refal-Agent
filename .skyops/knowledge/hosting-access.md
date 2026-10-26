# REFAL Hosting and DNS Access

<a id="20261014-refal-hosting-access"></a>
- **[2026-10-14] REFAL hosting and DNS access references** <!-- id: 20261014-refal-hosting-access -->
  - Plesk sign-in: `https://sad-villani.85-215-200-134.plesk.page:8443/`.
  - Plesk account usernames: `sam` and `admin.lamar`. Passwords are stored in Windows Credential Manager under `REFAL-PLESK-SAM` and `REFAL-PLESK-ADMIN-LAMAR`; retrieve them through Windows Credential Manager APIs without printing or writing them to files.
  - GoDaddy sign-in: `https://sso.godaddy.com/`; account username `refalco`. The password is stored in Windows Credential Manager under `REFAL-GODADDY-REFALCO`.
  - GoDaddy task context: manage SSL/DNS for `agent.refalco.com`.
  - Plesk sites observed: `refalco.com` and `company.refalco.com`. On 2026-10-14, the Plesk customer panel exposed PHP/Git/scheduled tasks but no Node.js controls, and the domain's SSH access was forbidden. The dashboard requires a Node.js host; ask the hosting provider to enable Plesk Node.js Toolkit or deploy on another Node-capable host. Do not overwrite the live company site when publishing the admin dashboard.
  - Never store the passwords in this memory file, repository files, logs, or chat.
