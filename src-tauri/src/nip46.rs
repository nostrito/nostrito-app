//! Custom NIP-46 (Nostr Connect) client with NIP-44 + NIP-04 support.
//!
//! nostr-sdk v0.35's built-in `Nip46Signer` only supports NIP-04 encryption
//! for the kind-24133 transport. Modern signers (nsec.app, Amber, etc.) have
//! moved to NIP-44 per the updated NIP-46 spec. This module implements the
//! full protocol with both encryption schemes: NIP-44 for sending and
//! NIP-44-then-NIP-04 fallback for receiving.

use std::time::Duration;

use nostr_sdk::prelude::*;
use nostr_sdk::prelude::nip46::{
    Message as Nip46Message, Request as Nip46Request, ResponseResult as Nip46Response,
};
use nostr_sdk::pool::{
    RelayPool, RelayPoolNotification, RelaySendOptions, SubscribeOptions,
};
use nostr_sdk::RelayOptions;

#[derive(Debug)]
pub struct Nip46Client {
    app_keys: Keys,
    signer_public_key: PublicKey,
    pool: RelayPool,
    timeout: Duration,
}

impl Clone for Nip46Client {
    fn clone(&self) -> Self {
        Self {
            app_keys: self.app_keys.clone(),
            signer_public_key: self.signer_public_key,
            pool: self.pool.clone(),
            timeout: self.timeout,
        }
    }
}

/// Decrypt a NIP-46 message: try NIP-44 first, fall back to NIP-04.
fn decrypt_nip46_msg(
    secret_key: &SecretKey,
    sender_pk: &PublicKey,
    content: &str,
) -> Result<String, String> {
    // Try NIP-44 first (current spec)
    if let Ok(plain) = nip44::decrypt(secret_key, sender_pk, content) {
        return Ok(plain);
    }
    // Fall back to NIP-04 (legacy)
    nip04::decrypt(secret_key, sender_pk, content)
        .map_err(|e| format!("Decryption failed (tried NIP-44 and NIP-04): {}", e))
}

/// Encrypt a NIP-46 message with NIP-44.
fn encrypt_nip46_msg(
    secret_key: &SecretKey,
    recipient_pk: &PublicKey,
    content: &str,
) -> Result<String, String> {
    nip44::encrypt(secret_key, recipient_pk, content, nip44::Version::V2)
        .map_err(|e| format!("NIP-44 encryption failed: {}", e))
}

impl Nip46Client {
    /// Connect via a `bunker://` URI.
    pub async fn connect_bunker(
        uri: &NostrConnectURI,
        app_keys: Keys,
        timeout: Duration,
    ) -> Result<Self, String> {
        let signer_pk = uri.signer_public_key()
            .ok_or("bunker:// URI must contain signer public key")?;
        let secret = uri.secret();

        let pool = Self::create_pool(uri.relays()).await?;
        Self::subscribe(&app_keys, &pool).await?;

        let client = Self {
            app_keys,
            signer_public_key: signer_pk,
            pool,
            timeout,
        };

        // Send `connect` command
        let req = Nip46Request::Connect {
            public_key: signer_pk,
            secret,
        };
        let res = client.send_request(req).await?;
        res.to_connect().map_err(|e| format!("Connect handshake failed: {}", e))?;

        tracing::info!("[nip46] Bunker connected, signer_pk={}", signer_pk.to_hex()[..16].to_string());
        Ok(client)
    }

    /// Connect via a `nostrconnect://` URI (client-initiated).
    /// Blocks until the remote signer sends a `connect` message.
    pub async fn connect_nostrconnect(
        uri: &NostrConnectURI,
        app_keys: Keys,
        timeout: Duration,
    ) -> Result<Self, String> {
        let pool = Self::create_pool(uri.relays()).await?;
        Self::subscribe(&app_keys, &pool).await?;

        // Wait for the signer to send a connect message
        let signer_pk = Self::wait_for_signer(&app_keys, &pool, timeout).await?;

        tracing::info!("[nip46] Nostr Connect completed, signer_pk={}", signer_pk.to_hex()[..16].to_string());
        Ok(Self {
            app_keys,
            signer_public_key: signer_pk,
            pool,
            timeout,
        })
    }

    /// Get the signer's public key (= the user's npub).
    pub fn signer_public_key(&self) -> PublicKey {
        self.signer_public_key
    }

    /// Get a bunker:// URI for reconnection.
    pub async fn bunker_uri(&self) -> NostrConnectURI {
        NostrConnectURI::Bunker {
            signer_public_key: self.signer_public_key,
            relays: self.pool.relays().await.into_keys().collect(),
            secret: None,
        }
    }

    /// Get the app's local keys (for persisting to keychain).
    pub fn local_keys(&self) -> &Keys {
        &self.app_keys
    }

    /// Request NIP-04 decryption from the remote signer.
    pub async fn nip04_decrypt(
        &self,
        public_key: PublicKey,
        ciphertext: String,
    ) -> Result<String, String> {
        let req = Nip46Request::Nip04Decrypt {
            public_key,
            ciphertext,
        };
        let res = self.send_request(req).await?;
        res.to_encrypt_decrypt().map_err(|e| format!("Decrypt response error: {}", e))
    }

    /// Request event signing from the remote signer.
    pub async fn sign_event(&self, unsigned: UnsignedEvent) -> Result<Event, String> {
        let req = Nip46Request::SignEvent(unsigned);
        let res = self.send_request(req).await?;
        res.to_sign_event().map_err(|e| format!("Sign response error: {}", e))
    }

    /// Shut down the relay pool.
    pub async fn shutdown(self) -> Result<(), String> {
        self.pool.shutdown().await.map_err(|e| format!("Pool shutdown error: {}", e))
    }

    // ── Internal helpers ──────────────────────────────────────────────

    async fn create_pool(relays: Vec<Url>) -> Result<RelayPool, String> {
        let pool = RelayPool::default();
        let opts = RelayOptions::default();

        if relays.is_empty() {
            return Err("No relay URLs provided".into());
        }

        for url in &relays {
            pool.add_relay(url.clone(), opts.clone())
                .await
                .map_err(|e| format!("Failed to add relay {}: {}", url, e))?;
        }

        // Start connection (returns immediately, connections happen in background)
        pool.connect(Some(Duration::from_secs(30))).await;

        // Poll until at least one relay is connected (up to 20 seconds)
        let mut connected = false;
        for i in 0..40 {
            let relay_map = pool.relays().await;
            for (url, relay) in &relay_map {
                let status = relay.status().await;
                if i % 10 == 0 {
                    tracing::debug!("[nip46] Relay {} status: {}", url, status);
                }
                if status == nostr_sdk::RelayStatus::Connected {
                    tracing::info!("[nip46] Relay {} connected", url);
                    connected = true;
                    break;
                }
            }
            if connected { break; }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        if !connected {
            let relay_map = pool.relays().await;
            let statuses: Vec<String> = futures_util::future::join_all(
                relay_map.iter().map(|(url, relay)| async move {
                    format!("{}: {}", url, relay.status().await)
                })
            ).await;
            return Err(format!(
                "No relays connected after 20s. Relay statuses: {}",
                statuses.join(", ")
            ));
        }

        Ok(pool)
    }

    async fn subscribe(app_keys: &Keys, pool: &RelayPool) -> Result<(), String> {
        let filter = Filter::new()
            .pubkey(app_keys.public_key())
            .kind(Kind::NostrConnect)
            .limit(0);

        pool.subscribe(vec![filter], SubscribeOptions::default())
            .await
            .map_err(|e| format!("Failed to subscribe on relay: {}", e))?;

        Ok(())
    }

    /// Wait for a remote signer to send a connect message (nostrconnect:// flow).
    async fn wait_for_signer(
        app_keys: &Keys,
        pool: &RelayPool,
        timeout: Duration,
    ) -> Result<PublicKey, String> {
        let secret_key = app_keys.secret_key();
        let mut notifications = pool.notifications();

        let result = async_utility::time::timeout(Some(timeout), async {
            while let Ok(notification) = notifications.recv().await {
                if let RelayPoolNotification::Event { event, .. } = notification {
                    if event.kind == Kind::NostrConnect {
                        match decrypt_nip46_msg(secret_key, &event.pubkey, &event.content) {
                            Ok(json) => {
                                tracing::debug!("[nip46] Received message: {}", &json[..json.len().min(120)]);
                                match Nip46Message::from_json(&json) {
                                    Ok(Nip46Message::Request {
                                        req: Nip46Request::Connect { public_key, .. },
                                        ..
                                    }) => return Ok(public_key),
                                    Ok(Nip46Message::Response {
                                        result: Some(Nip46Response::Connect),
                                        ..
                                    }) => return Ok(event.pubkey),
                                    _ => {} // ignore non-connect messages
                                }
                            }
                            Err(e) => {
                                tracing::warn!("[nip46] Failed to decrypt incoming msg: {}", e);
                            }
                        }
                    }
                }
            }
            Err("Signer connection stream ended".to_string())
        })
        .await
        .ok_or_else(|| "Timed out waiting for signer to connect".to_string())?;

        result
    }

    /// Send a NIP-46 request and wait for the matching response.
    async fn send_request(&self, req: Nip46Request) -> Result<Nip46Response, String> {
        let secret_key = self.app_keys.secret_key();
        let signer_pk = self.signer_public_key;

        // Build the request message
        let msg = Nip46Message::request(req);
        let req_id = msg.id().to_string();
        let msg_json = msg.as_json();

        tracing::debug!("[nip46] Sending request {}: {}", &req_id, &msg_json[..msg_json.len().min(100)]);

        // Encrypt with NIP-44 and build kind 24133 event
        let encrypted = encrypt_nip46_msg(secret_key, &signer_pk, &msg_json)?;
        let event = EventBuilder::new(Kind::NostrConnect, encrypted, [Tag::public_key(signer_pk)])
            .to_event(&self.app_keys)
            .map_err(|e| format!("Failed to build event: {}", e))?;

        let mut notifications = self.pool.notifications();

        // Send the event
        self.pool
            .send_event(event, RelaySendOptions::new())
            .await
            .map_err(|e| format!("Failed to send request: {}", e))?;

        // Wait for matching response
        let result = async_utility::time::timeout(Some(self.timeout), async {
            while let Ok(notification) = notifications.recv().await {
                if let RelayPoolNotification::Event { event, .. } = notification {
                    if event.kind == Kind::NostrConnect {
                        match decrypt_nip46_msg(secret_key, &event.pubkey, &event.content) {
                            Ok(json) => {
                                tracing::debug!("[nip46] Received response: {}", &json[..json.len().min(120)]);
                                match Nip46Message::from_json(&json) {
                                    Ok(Nip46Message::Response { id, result, error }) if id == req_id => {
                                        if let Some(result) = result {
                                            if result.is_auth_url() {
                                                tracing::warn!("[nip46] Auth URL received: {:?}", error);
                                                continue; // wait for real response
                                            }
                                            return Ok(result);
                                        }
                                        if let Some(error) = error {
                                            return Err(format!("Signer error: {}", error));
                                        }
                                        return Err("Empty response from signer".to_string());
                                    }
                                    _ => {} // ignore non-matching messages
                                }
                            }
                            Err(e) => {
                                tracing::warn!("[nip46] Decrypt response failed: {}", e);
                            }
                        }
                    }
                }
            }
            Err("Response stream ended".to_string())
        })
        .await
        .ok_or_else(|| "Timed out waiting for signer response".to_string())?;

        result
    }
}
