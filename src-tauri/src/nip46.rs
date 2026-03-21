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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Nip46Encryption {
    Nip44,
    Nip04,
}

#[derive(Debug)]
pub struct Nip46Client {
    app_keys: Keys,
    signer_public_key: PublicKey,
    pool: RelayPool,
    timeout: Duration,
    /// Original secret from bunker URI, needed for reconnection
    secret: Option<String>,
    /// Which encryption the signer uses (detected during handshake)
    encryption: Nip46Encryption,
}

impl Clone for Nip46Client {
    fn clone(&self) -> Self {
        Self {
            app_keys: self.app_keys.clone(),
            signer_public_key: self.signer_public_key,
            pool: self.pool.clone(),
            timeout: self.timeout,
            secret: self.secret.clone(),
            encryption: self.encryption,
        }
    }
}

/// Decrypt a NIP-46 message: try NIP-44 first, fall back to NIP-04.
/// Returns (plaintext, which_encryption_worked).
fn decrypt_nip46_msg(
    secret_key: &SecretKey,
    sender_pk: &PublicKey,
    content: &str,
) -> Result<(String, Nip46Encryption), String> {
    // Try NIP-44 first (current spec)
    if let Ok(plain) = nip44::decrypt(secret_key, sender_pk, content) {
        return Ok((plain, Nip46Encryption::Nip44));
    }
    // Fall back to NIP-04 (legacy)
    match nip04::decrypt(secret_key, sender_pk, content) {
        Ok(plain) => Ok((plain, Nip46Encryption::Nip04)),
        Err(e) => Err(format!("Decryption failed (tried NIP-44 and NIP-04): {}", e)),
    }
}

/// Encrypt a NIP-46 message, matching the signer's encryption scheme.
fn encrypt_nip46_msg(
    secret_key: &SecretKey,
    recipient_pk: &PublicKey,
    content: &str,
    encryption: Nip46Encryption,
) -> Result<String, String> {
    match encryption {
        Nip46Encryption::Nip44 => {
            nip44::encrypt(secret_key, recipient_pk, content, nip44::Version::V2)
                .map_err(|e| format!("NIP-44 encryption failed: {}", e))
        }
        Nip46Encryption::Nip04 => {
            nip04::encrypt(secret_key, recipient_pk, content)
                .map_err(|e| format!("NIP-04 encryption failed: {}", e))
        }
    }
}

impl Nip46Client {
    /// Connect via a `bunker://` URI (with connect handshake).
    pub async fn connect_bunker(
        uri: &NostrConnectURI,
        app_keys: Keys,
        timeout: Duration,
    ) -> Result<Self, String> {
        let signer_pk = uri.signer_public_key()
            .ok_or("bunker:// URI must contain signer public key")?;
        let secret = uri.secret();

        tracing::info!("[nip46] connect_bunker: signer_pk={}..., has_secret={}, relays={:?}",
            &signer_pk.to_hex()[..12], secret.is_some(), uri.relays().iter().map(|u| u.as_str()).collect::<Vec<_>>());

        let pool = Self::create_pool(uri.relays()).await?;
        Self::subscribe(&app_keys, &pool).await?;

        // Start with NIP-44, will detect signer's preference from response
        let mut client = Self {
            app_keys,
            signer_public_key: signer_pk,
            pool,
            timeout,
            secret: secret.clone(),
            encryption: Nip46Encryption::Nip44,
        };

        // Send `connect` command — try NIP-44 first, fall back to NIP-04
        let req = Nip46Request::Connect {
            public_key: signer_pk,
            secret,
        };
        match client.send_request(req.clone()).await {
            Ok(res) => {
                res.to_connect().map_err(|e| format!("Connect handshake failed: {}", e))?;
            }
            Err(_) => {
                tracing::info!("[nip46] NIP-44 connect failed, retrying with NIP-04...");
                client.encryption = Nip46Encryption::Nip04;
                let res = client.send_request(req).await?;
                res.to_connect().map_err(|e| format!("Connect handshake (NIP-04) failed: {}", e))?;
            }
        }

        tracing::info!("[nip46] Bunker connected (encryption={:?}), signer_pk={}",
            client.encryption, signer_pk.to_hex()[..16].to_string());
        Ok(client)
    }

    /// Reconnect to a previously paired signer without sending a `connect` request.
    /// Used for sessions that were originally established via nostrconnect:// — the
    /// signer already knows our app_keys from the initial pairing, so we just need
    /// to set up the relay pool and subscription, then can send requests directly.
    pub async fn reconnect(
        signer_public_key: PublicKey,
        relays: Vec<Url>,
        app_keys: Keys,
        secret: Option<String>,
        encryption: Nip46Encryption,
        timeout: Duration,
    ) -> Result<Self, String> {
        tracing::info!("[nip46] reconnect: signer_pk={}..., encryption={:?}, relays={:?}",
            &signer_public_key.to_hex()[..12], encryption, relays.iter().map(|u| u.as_str()).collect::<Vec<_>>());

        let pool = Self::create_pool(relays).await?;
        Self::subscribe(&app_keys, &pool).await?;

        tracing::info!("[nip46] reconnect: pool ready, using stored encryption={:?}", encryption);
        Ok(Self {
            app_keys,
            signer_public_key,
            pool,
            timeout,
            secret,
            encryption,
        })
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
        let (signer_pk, encryption) = Self::wait_for_signer(&app_keys, &pool, timeout).await?;

        tracing::info!("[nip46] Nostr Connect completed (encryption={:?}), signer_pk={}",
            encryption, signer_pk.to_hex()[..16].to_string());
        Ok(Self {
            app_keys,
            signer_public_key: signer_pk,
            pool,
            timeout,
            secret: None,
            encryption,
        })
    }

    /// Get the signer's public key (= the user's npub).
    pub fn signer_public_key(&self) -> PublicKey {
        self.signer_public_key
    }

    /// Get the detected encryption scheme.
    pub fn encryption(&self) -> Nip46Encryption {
        self.encryption
    }

    /// Get a bunker:// URI for reconnection (includes original secret if available).
    pub async fn bunker_uri(&self) -> NostrConnectURI {
        NostrConnectURI::Bunker {
            signer_public_key: self.signer_public_key,
            relays: self.pool.relays().await.into_keys().collect(),
            secret: self.secret.clone(),
        }
    }

    /// Get the app's local keys (for persisting to keychain).
    pub fn local_keys(&self) -> &Keys {
        &self.app_keys
    }

    /// Request NIP-04 encryption from the remote signer.
    pub async fn nip04_encrypt(
        &self,
        public_key: PublicKey,
        text: String,
    ) -> Result<String, String> {
        let req = Nip46Request::Nip04Encrypt {
            public_key,
            text,
        };
        let res = self.send_request(req).await?;
        res.to_encrypt_decrypt().map_err(|e| format!("Encrypt response error: {}", e))
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
    /// Tries detected encryption first (15s). If no response, retries with
    /// the other encryption. Handles signers using different encryption than
    /// what was detected during the connect handshake.
    pub async fn sign_event(&mut self, unsigned: UnsignedEvent) -> Result<Event, String> {
        tracing::info!("[nip46] sign_event: kind={}, content_len={}, signer_pk={}..., encryption={:?}",
            unsigned.kind.as_u16(), unsigned.content.len(),
            &self.signer_public_key.to_hex()[..12], self.encryption);

        let req = Nip46Request::SignEvent(unsigned);
        let primary = self.encryption;

        // Try primary encryption with 15s timeout
        match self.send_request_with_timeout(req.clone(), Duration::from_secs(15)).await {
            Ok(res) => {
                tracing::info!("[nip46] sign_event succeeded with {:?}", primary);
                return res.to_sign_event().map_err(|e| format!("Sign response error: {}", e));
            }
            Err(e) => {
                tracing::warn!("[nip46] {:?} no response in 15s: {} — trying other encryption", primary, e);
            }
        }

        // Flip encryption and retry
        let fallback = match primary {
            Nip46Encryption::Nip44 => Nip46Encryption::Nip04,
            Nip46Encryption::Nip04 => Nip46Encryption::Nip44,
        };
        self.encryption = fallback;
        tracing::info!("[nip46] retrying sign_event with {:?}", fallback);

        match self.send_request_with_timeout(req, self.timeout).await {
            Ok(res) => {
                tracing::info!("[nip46] sign_event succeeded with {:?}", fallback);
                res.to_sign_event().map_err(|e| format!("Sign response error: {}", e))
            }
            Err(e) => {
                self.encryption = primary;
                tracing::error!("[nip46] sign_event failed with both NIP-44 and NIP-04");
                Err(format!("Signer did not respond (tried NIP-44 and NIP-04): {}", e))
            }
        }
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
    /// Returns (signer_public_key, detected_encryption).
    async fn wait_for_signer(
        app_keys: &Keys,
        pool: &RelayPool,
        timeout: Duration,
    ) -> Result<(PublicKey, Nip46Encryption), String> {
        let secret_key = app_keys.secret_key();
        let mut notifications = pool.notifications();

        let result = async_utility::time::timeout(Some(timeout), async {
            while let Ok(notification) = notifications.recv().await {
                if let RelayPoolNotification::Event { event, .. } = notification {
                    if event.kind == Kind::NostrConnect {
                        match decrypt_nip46_msg(secret_key, &event.pubkey, &event.content) {
                            Ok((json, enc)) => {
                                tracing::info!("[nip46] Received connect message (encryption={:?}): {}",
                                    enc, &json[..json.len().min(120)]);
                                match Nip46Message::from_json(&json) {
                                    Ok(Nip46Message::Request {
                                        req: Nip46Request::Connect { public_key, .. },
                                        ..
                                    }) => return Ok((public_key, enc)),
                                    Ok(Nip46Message::Response {
                                        result: Some(Nip46Response::Connect),
                                        ..
                                    }) => return Ok((event.pubkey, enc)),
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

    /// Ensure relay pool is connected and subscribed before sending requests.
    async fn ensure_connected(&self) -> Result<(), String> {
        // Check if any relay is connected
        let relay_map = self.pool.relays().await;
        let mut any_connected = false;
        for (url, relay) in &relay_map {
            let status = relay.status().await;
            tracing::info!("[nip46] relay {} status: {}", url, status);
            if status == nostr_sdk::RelayStatus::Connected {
                any_connected = true;
            }
        }

        if !any_connected {
            tracing::warn!("[nip46] no relays connected, attempting reconnect...");
            self.pool.connect(Some(Duration::from_secs(10))).await;

            // Wait for at least one connection
            for _ in 0..20 {
                let relay_map = self.pool.relays().await;
                for (_, relay) in &relay_map {
                    if relay.status().await == nostr_sdk::RelayStatus::Connected {
                        any_connected = true;
                        break;
                    }
                }
                if any_connected { break; }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }

            if !any_connected {
                return Err("NIP-46 relay pool: no relays could reconnect".to_string());
            }
            tracing::info!("[nip46] relay reconnected");
        }

        // Re-subscribe to ensure we receive responses (relays may drop subscriptions)
        Self::subscribe(&self.app_keys, &self.pool).await?;
        tracing::info!("[nip46] subscription refreshed");

        Ok(())
    }

    /// Send a NIP-46 request with default timeout.
    async fn send_request(&self, req: Nip46Request) -> Result<Nip46Response, String> {
        self.send_request_with_timeout(req, self.timeout).await
    }

    /// Send a NIP-46 request and wait for the matching response.
    async fn send_request_with_timeout(&self, req: Nip46Request, timeout: Duration) -> Result<Nip46Response, String> {
        let secret_key = self.app_keys.secret_key();
        let signer_pk = self.signer_public_key;

        // Ensure pool is healthy before sending
        self.ensure_connected().await?;

        // Build the request message
        let msg = Nip46Message::request(req);
        let req_id = msg.id().to_string();
        let msg_json = msg.as_json();

        tracing::info!("[nip46] === NIP-46 REQUEST ===");
        tracing::info!("[nip46] req_id={}, encryption={:?}, timeout={}s", &req_id, self.encryption, timeout.as_secs());
        tracing::info!("[nip46] app_pubkey={}", self.app_keys.public_key().to_hex());
        tracing::info!("[nip46] signer_pk={} (p-tag target)", signer_pk.to_hex());
        tracing::info!("[nip46] method={}", &msg_json[..msg_json.len().min(80)]);

        // Encrypt and build kind 24133 event
        let encrypted = encrypt_nip46_msg(secret_key, &signer_pk, &msg_json, self.encryption)?;
        let event = EventBuilder::new(Kind::NostrConnect, encrypted, [Tag::public_key(signer_pk)])
            .to_event(&self.app_keys)
            .map_err(|e| format!("Failed to build event: {}", e))?;

        // Subscribe to notifications BEFORE sending so we don't miss the response
        let mut notifications = self.pool.notifications();

        // Send the event
        match self.pool.send_event(event.clone(), RelaySendOptions::new()).await {
            Ok(output) => {
                let accepted: Vec<String> = output.success.iter().map(|u| u.to_string()).collect();
                let rejected: Vec<String> = output.failed.iter().map(|(u, e)| format!("{}: {:?}", u, e)).collect();
                tracing::info!("[nip46] event {} sent — accepted=[{}], rejected=[{}]",
                    &event.id.to_hex()[..12], accepted.join(", "), rejected.join(", "));
                if output.success.is_empty() {
                    return Err("Event was not accepted by any relay".to_string());
                }
            }
            Err(e) => {
                return Err(format!("Failed to send NIP-46 request: {}", e));
            }
        }

        tracing::info!("[nip46] waiting for response (timeout={}s, req_id={})...", timeout.as_secs(), &req_id);

        // Wait for matching response
        let result = async_utility::time::timeout(Some(timeout), async {
            while let Ok(notification) = notifications.recv().await {
                if let RelayPoolNotification::Event { event, .. } = notification {
                    if event.kind == Kind::NostrConnect {
                        match decrypt_nip46_msg(secret_key, &event.pubkey, &event.content) {
                            Ok((json, enc)) => {
                                tracing::info!("[nip46] received NIP-46 message (enc={:?}): {}", enc, &json[..json.len().min(200)]);
                                match Nip46Message::from_json(&json) {
                                    Ok(Nip46Message::Response { id, result, error }) if id == req_id => {
                                        if let Some(result) = result {
                                            if result.is_auth_url() {
                                                tracing::warn!("[nip46] Auth URL received: {:?}", error);
                                                continue; // wait for real response
                                            }
                                            tracing::info!("[nip46] got matching response for req_id={}", &req_id);
                                            return Ok(result);
                                        }
                                        if let Some(error) = error {
                                            return Err(format!("Signer error: {}", error));
                                        }
                                        return Err("Empty response from signer".to_string());
                                    }
                                    Ok(other) => {
                                        tracing::debug!("[nip46] ignoring non-matching message: {:?}", other);
                                    }
                                    Err(e) => {
                                        tracing::warn!("[nip46] failed to parse NIP-46 message: {}", e);
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!("[nip46] decrypt response failed: {}", e);
                            }
                        }
                    }
                }
            }
            Err("Response stream ended".to_string())
        })
        .await
        .ok_or_else(|| {
            tracing::error!("[nip46] timed out after {}s waiting for signer response (req_id={})", self.timeout.as_secs(), &req_id);
            "Timed out waiting for signer response".to_string()
        })?;

        result
    }
}
