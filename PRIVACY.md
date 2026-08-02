# Privacy

peerbox is built to collect nothing. Not as a policy — there is
nowhere for data to go, by design.

**What peerbox does not have:**
- No accounts, no sign-up, no email or phone number
- No server-side database of any kind
- No local storage either — nothing is saved on your device, not even
  encrypted. Close the tab and the entire session is gone. This is a
  deliberate "walkie-talkie" design: use it live, then it's over.
- No analytics, no tracking pixels, no crash reporting sent anywhere
- No cookies

**What technically has to happen for any of this to work at all:**
- A public signaling broker (currently PeerJS's free service) briefly
  helps two browsers find each other before they connect directly. It
  sees the two random session IDs involved for a moment, nothing else
  — not messages, not files, not call content.
- A TURN relay server (currently the free Open Relay Project) relays
  the encrypted connection between two peers so neither one sees the
  other's real IP address. It sees that two IDs are exchanging
  encrypted data and roughly how much, but not the content — it
  cannot decrypt what passes through it.

Both of those are third-party free services today. The plan is to move
to a self-hosted relay once that's affordable, removing even that
dependency.

**What you should know as a realistic limit, not a flaw:**
No software can protect data on a device that is itself compromised,
physically accessed while unlocked, or running a malicious browser
extension. peerbox protects what happens between two browsers — it
can't protect a browser someone else already controls.
