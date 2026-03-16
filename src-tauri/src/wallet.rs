use nostr_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletInfo {
    pub wallet_type: String,
    pub connected: bool,
    pub alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletTransaction {
    pub payment_hash: String,
    pub bolt11: Option<String>,
    pub amount: i64,
    pub fee: Option<u64>,
    pub memo: Option<String>,
    pub status: String,
    pub created_at: u64,
    pub preimage: Option<String>,
    pub linked_zap_event: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedInvoice {
    pub amount_sats: Option<u64>,
    pub description: Option<String>,
    pub payment_hash: Option<String>,
    pub expiry: u64,
    pub timestamp: u64,
}

// ── Wallet State ─────────────────────────────────────────────────────

pub enum WalletProvider {
    LNbits {
        url: String,
        admin_key: String,
    },
    Nwc {
        client: nostr_sdk::NWC,
    },
}

pub struct WalletState {
    pub provider: WalletProvider,
    pub wallet_type: String,
    pub alias: Option<String>,
}

pub type SharedWalletState = Arc<RwLock<Option<WalletState>>>;

pub fn new_shared_wallet_state() -> SharedWalletState {
    Arc::new(RwLock::new(None))
}

// ── LNbits Client ────────────────────────────────────────────────────

pub mod lnbits {
    use super::*;

    #[derive(Deserialize)]
    struct WalletResponse {
        name: Option<String>,
        balance: Option<i64>,
    }

    #[derive(Deserialize)]
    struct InvoiceResponse {
        payment_hash: Option<String>,
        payment_request: Option<String>,
    }

    #[derive(Deserialize)]
    struct PayResponse {
        payment_hash: Option<String>,
        checking_id: Option<String>,
    }

    #[derive(Deserialize)]
    struct LnbitsTransaction {
        payment_hash: Option<String>,
        bolt11: Option<String>,
        amount: Option<i64>,
        fee: Option<i64>,
        memo: Option<String>,
        status: Option<String>,
        time: Option<i64>,
        preimage: Option<String>,
    }

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    pub async fn get_info(url: &str, key: &str) -> Result<(String, u64), String> {
        let resp = client()
            .get(format!("{}/api/v1/wallet", url))
            .header("X-Api-Key", key)
            .send()
            .await
            .map_err(|e| format!("LNbits request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("LNbits error: {}", resp.status()));
        }

        let data: WalletResponse = resp
            .json()
            .await
            .map_err(|e| format!("LNbits parse error: {}", e))?;

        let balance_msats = data.balance.unwrap_or(0);
        let balance_sats = (balance_msats / 1000) as u64;
        let alias = data.name.unwrap_or_default();

        Ok((alias, balance_sats))
    }

    pub async fn get_balance(url: &str, key: &str) -> Result<u64, String> {
        let (_, balance) = get_info(url, key).await?;
        Ok(balance)
    }

    pub async fn pay_invoice(url: &str, key: &str, bolt11: &str) -> Result<String, String> {
        let resp = client()
            .post(format!("{}/api/v1/payments", url))
            .header("X-Api-Key", key)
            .json(&serde_json::json!({
                "out": true,
                "bolt11": bolt11,
            }))
            .send()
            .await
            .map_err(|e| format!("LNbits pay failed: {}", e))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("LNbits pay error: {}", body));
        }

        let data: PayResponse = resp
            .json()
            .await
            .map_err(|e| format!("LNbits parse error: {}", e))?;

        Ok(data
            .payment_hash
            .or(data.checking_id)
            .unwrap_or_default())
    }

    pub async fn make_invoice(
        url: &str,
        key: &str,
        amount_sats: u64,
        memo: Option<&str>,
    ) -> Result<(String, String), String> {
        let mut body = serde_json::json!({
            "out": false,
            "amount": amount_sats,
        });
        if let Some(m) = memo {
            body["memo"] = serde_json::Value::String(m.to_string());
        }

        let resp = client()
            .post(format!("{}/api/v1/payments", url))
            .header("X-Api-Key", key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("LNbits invoice failed: {}", e))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("LNbits invoice error: {}", body));
        }

        let data: InvoiceResponse = resp
            .json()
            .await
            .map_err(|e| format!("LNbits parse error: {}", e))?;

        Ok((
            data.payment_request.unwrap_or_default(),
            data.payment_hash.unwrap_or_default(),
        ))
    }

    pub async fn list_transactions(
        url: &str,
        key: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<WalletTransaction>, String> {
        let resp = client()
            .get(format!(
                "{}/api/v1/payments?limit={}&offset={}",
                url, limit, offset
            ))
            .header("X-Api-Key", key)
            .send()
            .await
            .map_err(|e| format!("LNbits list failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("LNbits list error: {}", resp.status()));
        }

        let txs: Vec<LnbitsTransaction> = resp
            .json()
            .await
            .map_err(|e| format!("LNbits parse error: {}", e))?;

        Ok(txs
            .into_iter()
            .map(|tx| {
                let amount_msats = tx.amount.unwrap_or(0);
                let fee_msats = tx.fee.unwrap_or(0);
                let status_str = tx.status.as_deref().unwrap_or("unknown");
                let mapped_status = match status_str {
                    "success" => "settled",
                    "pending" => "pending",
                    _ => "failed",
                };

                WalletTransaction {
                    payment_hash: tx.payment_hash.unwrap_or_default(),
                    bolt11: tx.bolt11,
                    amount: amount_msats / 1000,
                    fee: Some((fee_msats.unsigned_abs()) / 1000),
                    memo: tx.memo,
                    status: mapped_status.to_string(),
                    created_at: tx.time.unwrap_or(0) as u64,
                    preimage: tx.preimage,
                    linked_zap_event: None,
                }
            })
            .collect())
    }
}

// ── NWC Client ───────────────────────────────────────────────────────

pub mod nwc_provider {
    use super::*;
    use nostr_sdk::nips::nip47::{
        ListTransactionsRequestParams, MakeInvoiceRequestParams, TransactionType,
    };

    pub fn parse_uri(uri: &str) -> Result<NostrWalletConnectURI, String> {
        uri.parse::<NostrWalletConnectURI>()
            .map_err(|e| format!("Invalid NWC URI: {}", e))
    }

    pub async fn connect(uri: &str) -> Result<(nostr_sdk::NWC, Option<String>), String> {
        let parsed = parse_uri(uri)?;
        let client = nostr_sdk::NWC::new(parsed);

        // Try to get wallet info for alias
        let alias = match client.get_info().await {
            Ok(info) => {
                let a = info.alias.trim().to_string();
                if a.is_empty() { None } else { Some(a) }
            }
            Err(_) => None,
        };

        Ok((client, alias))
    }

    pub async fn get_balance(client: &nostr_sdk::NWC) -> Result<u64, String> {
        let balance_msats = client
            .get_balance()
            .await
            .map_err(|e| format!("NWC get_balance failed: {}", e))?;
        Ok(balance_msats / 1000)
    }

    pub async fn pay_invoice(client: &nostr_sdk::NWC, bolt11: &str) -> Result<String, String> {
        let preimage = client
            .pay_invoice(bolt11.to_string())
            .await
            .map_err(|e| format!("NWC pay_invoice failed: {}", e))?;
        Ok(preimage)
    }

    pub async fn make_invoice(
        client: &nostr_sdk::NWC,
        amount_sats: u64,
        memo: Option<&str>,
    ) -> Result<(String, String), String> {
        let params = MakeInvoiceRequestParams {
            amount: amount_sats * 1000, // sats → msats
            description: memo.map(String::from),
            description_hash: None,
            expiry: None,
        };
        let result = client
            .make_invoice(params)
            .await
            .map_err(|e| format!("NWC make_invoice failed: {}", e))?;
        Ok((result.invoice, result.payment_hash))
    }

    pub async fn list_transactions(
        client: &nostr_sdk::NWC,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<WalletTransaction>, String> {
        let params = ListTransactionsRequestParams {
            from: None,
            until: None,
            limit: Some(limit as u64),
            offset: Some(offset as u64),
            unpaid: Some(false),
            transaction_type: None,
        };

        let results = client
            .list_transactions(params)
            .await
            .map_err(|e| format!("NWC list_transactions failed: {}", e))?;

        Ok(results
            .into_iter()
            .map(|tx| {
                let amount_msats = tx.amount as i64;
                let is_incoming =
                    tx.transaction_type == Some(TransactionType::Incoming);
                let amount_sats = if is_incoming {
                    amount_msats / 1000
                } else {
                    -(amount_msats / 1000)
                };

                let created_at_secs = tx
                    .settled_at
                    .unwrap_or(tx.created_at)
                    .as_u64();

                WalletTransaction {
                    payment_hash: tx.payment_hash.clone(),
                    bolt11: tx.invoice.clone(),
                    amount: amount_sats,
                    fee: Some(tx.fees_paid / 1000),
                    memo: tx.description,
                    status: "settled".to_string(),
                    created_at: created_at_secs,
                    preimage: tx.preimage,
                    linked_zap_event: None,
                }
            })
            .collect())
    }
}

// ── BOLT11 Decoder ───────────────────────────────────────────────────

pub mod bolt11 {
    use super::DecodedInvoice;

    /// Decode a BOLT11 Lightning invoice and extract key fields.
    pub fn decode(invoice: &str) -> Result<DecodedInvoice, String> {
        let invoice_lower = invoice.trim().to_lowercase();

        // Must start with "ln" prefix
        if !invoice_lower.starts_with("ln") {
            return Err("Not a valid BOLT11 invoice".into());
        }

        // Use bech32 to decode
        let (hrp, data) =
            bech32::decode(&invoice_lower).map_err(|e| format!("Bech32 decode error: {}", e))?;

        // Parse HRP: "ln" + network + optional amount
        let hrp_str = hrp.to_string();
        let after_ln = &hrp_str[2..];

        // Extract network prefix and amount string
        let (amount_sats, _network) = parse_hrp_amount(after_ln);

        // Convert 5-bit data to fields
        // First 7 bytes (35 5-bit groups) = timestamp
        if data.len() < 7 {
            return Err("Invoice data too short".into());
        }

        let timestamp = words_to_u64(&data[..7]);

        // Parse tagged fields from remaining data (excluding signature at end)
        // Signature is 104 5-bit words at the end (65 bytes = 520 bits / 5 = 104)
        let sig_len = 104;
        if data.len() < 7 + sig_len {
            return Err("Invoice data too short for signature".into());
        }

        let tagged_data = &data[7..data.len() - sig_len];

        let mut payment_hash: Option<String> = None;
        let mut description: Option<String> = None;
        let mut expiry: u64 = 3600; // default 1 hour

        let mut pos = 0;
        while pos + 3 <= tagged_data.len() {
            let tag = tagged_data[pos];
            let data_len = (tagged_data[pos + 1] as usize) * 32 + (tagged_data[pos + 2] as usize);
            pos += 3;

            if pos + data_len > tagged_data.len() {
                break;
            }

            let field_data = &tagged_data[pos..pos + data_len];
            pos += data_len;

            match tag {
                1 => {
                    // Payment hash (256 bits = 52 5-bit words)
                    payment_hash = Some(words_to_hex(field_data));
                }
                13 => {
                    // Description (UTF-8)
                    description = Some(words_to_utf8(field_data));
                }
                6 => {
                    // Expiry (seconds)
                    expiry = words_to_u64(field_data);
                }
                _ => {} // Skip other tags
            }
        }

        Ok(DecodedInvoice {
            amount_sats,
            description,
            payment_hash,
            expiry,
            timestamp,
        })
    }

    /// Parse amount from HRP portion after network prefix.
    fn parse_hrp_amount(s: &str) -> (Option<u64>, String) {
        // Network prefixes: "bc" (mainnet), "tb" (testnet), "bcrt" (regtest)
        let (network, amount_str) = if s.starts_with("bcrt") {
            ("bcrt".to_string(), &s[4..])
        } else if s.starts_with("tb") {
            ("tb".to_string(), &s[2..])
        } else if s.starts_with("bc") {
            ("bc".to_string(), &s[2..])
        } else {
            return (None, s.to_string());
        };

        if amount_str.is_empty() {
            return (None, network);
        }

        // Last char is multiplier
        let (num_str, multiplier) = amount_str.split_at(amount_str.len() - 1);
        let num: f64 = match num_str.parse() {
            Ok(n) => n,
            Err(_) => return (None, network),
        };

        let sats = match multiplier {
            "m" => Some((num * 100_000.0) as u64),
            "u" => Some((num * 100.0) as u64),
            "n" => Some((num * 0.1) as u64),
            "p" => Some((num * 0.0001) as u64),
            _ => amount_str
                .parse::<f64>()
                .ok()
                .map(|n| (n * 100_000_000.0) as u64),
        };

        (sats, network)
    }

    fn words_to_u64(words: &[u8]) -> u64 {
        let mut val: u64 = 0;
        for &w in words {
            val = (val << 5) | (w as u64 & 0x1f);
        }
        val
    }

    fn words_to_hex(words: &[u8]) -> String {
        let bytes = convert_bits(words, 5, 8, false);
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn words_to_utf8(words: &[u8]) -> String {
        let bytes = convert_bits(words, 5, 8, false);
        String::from_utf8_lossy(&bytes).to_string()
    }

    fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Vec<u8> {
        let mut acc: u32 = 0;
        let mut bits: u32 = 0;
        let mut result = Vec::new();
        let maxv = (1u32 << to) - 1;

        for &value in data {
            acc = (acc << from) | (value as u32);
            bits += from;
            while bits >= to {
                bits -= to;
                result.push(((acc >> bits) & maxv) as u8);
            }
        }

        if pad && bits > 0 {
            result.push(((acc << (to - bits)) & maxv) as u8);
        }

        result
    }
}

// ── Wallet Provisioning ─────────────────────────────────────────────

pub mod provision {
    use nostr_sdk::prelude::*;

    const DEFAULT_PROVISION_URL: &str = "https://zaps.nostr-wot.com";

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    /// Auto-provision a wallet via challenge-response at the provisioning URL.
    /// Returns (admin_key, wallet_id, instance_url).
    pub async fn provision_wallet(
        instance_url: Option<&str>,
        nsec: &str,
        hex_pubkey: &str,
    ) -> Result<(String, String, String), String> {
        let url = instance_url.unwrap_or(DEFAULT_PROVISION_URL).trim_end_matches('/');

        // Step 1: GET challenge
        let challenge_resp = client()
            .get(format!("{}/api/provision/challenge", url))
            .send()
            .await
            .map_err(|e| format!("Provision challenge request failed: {}", e))?;

        if !challenge_resp.status().is_success() {
            let body = challenge_resp.text().await.unwrap_or_default();
            return Err(format!("Provision challenge error: {}", body));
        }

        let challenge_data: serde_json::Value = challenge_resp
            .json()
            .await
            .map_err(|e| format!("Provision challenge parse error: {}", e))?;

        let challenge = challenge_data["challenge"]
            .as_str()
            .ok_or("No challenge in response")?
            .to_string();

        // Step 2: Sign challenge as kind:27235 event (NIP-98)
        let secret_key = SecretKey::from_bech32(nsec)
            .map_err(|e| format!("Invalid nsec: {}", e))?;
        let keys = Keys::new(secret_key);

        let tags = vec![
            Tag::custom(TagKind::Custom("challenge".into()), vec![challenge]),
            Tag::custom(TagKind::Custom("u".into()), vec![url.to_string()]),
            Tag::custom(TagKind::Custom("method".into()), vec!["POST".to_string()]),
        ];
        let event = EventBuilder::new(Kind::Custom(27235), "", tags)
            .to_event(&keys)
            .map_err(|e| format!("Failed to sign provision event: {}", e))?;

        let event_json = serde_json::to_string(&event)
            .map_err(|e| format!("Failed to serialize event: {}", e))?;

        // Step 3: POST provision with signed event
        let wallet_name = format!("Nostrito:{}", &hex_pubkey[..16.min(hex_pubkey.len())]);
        let provision_resp = client()
            .post(format!("{}/api/provision", url))
            .json(&serde_json::json!({
                "name": wallet_name,
                "event": event_json,
            }))
            .send()
            .await
            .map_err(|e| format!("Provision request failed: {}", e))?;

        if !provision_resp.status().is_success() {
            let body = provision_resp.text().await.unwrap_or_default();
            return Err(format!("Provision error: {}", body));
        }

        let result: serde_json::Value = provision_resp
            .json()
            .await
            .map_err(|e| format!("Provision parse error: {}", e))?;

        let admin_key = result["adminkey"]
            .as_str()
            .ok_or("No adminkey in provision response")?
            .to_string();
        let wallet_id = result["id"]
            .as_str()
            .ok_or("No id in provision response")?
            .to_string();

        Ok((admin_key, wallet_id, url.to_string()))
    }
}

// ── Zap Helpers (NIP-57 / LNURL) ───────────────────────────────────

pub mod zap {
    use nostr_sdk::prelude::*;
    use serde::Deserialize;

    #[derive(Debug, Clone)]
    pub struct LnurlPayParams {
        pub callback: String,
        pub min_sendable: u64,
        pub max_sendable: u64,
        pub allows_nostr: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LnurlResponse {
        callback: Option<String>,
        min_sendable: Option<u64>,
        max_sendable: Option<u64>,
        allows_nostr: Option<bool>,
    }

    #[derive(Deserialize)]
    struct InvoiceCallbackResponse {
        pr: Option<String>,
    }

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    /// Resolve a lightning address (user@domain) to LNURL pay parameters.
    pub async fn resolve_lnurl(lud16: &str) -> Result<LnurlPayParams, String> {
        let parts: Vec<&str> = lud16.split('@').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid lightning address: {}", lud16));
        }
        let (user, domain) = (parts[0], parts[1]);
        let url = format!("https://{}/.well-known/lnurlp/{}", domain, user);

        let resp = client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("LNURL resolve failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("LNURL resolve error: HTTP {}", resp.status()));
        }

        let data: LnurlResponse = resp
            .json()
            .await
            .map_err(|e| format!("LNURL parse error: {}", e))?;

        Ok(LnurlPayParams {
            callback: data.callback.ok_or("No callback in LNURL response")?,
            min_sendable: data.min_sendable.unwrap_or(1000),
            max_sendable: data.max_sendable.unwrap_or(100_000_000_000),
            allows_nostr: data.allows_nostr.unwrap_or(false),
        })
    }

    /// Build a NIP-57 kind:9734 zap request event and return it as a JSON string.
    pub fn build_zap_request(
        nsec: &str,
        recipient_pubkey: &str,
        event_id: &str,
        amount_msats: u64,
        content: &str,
        relays: &[String],
    ) -> Result<String, String> {
        let secret_key = SecretKey::from_bech32(nsec)
            .map_err(|e| format!("Invalid nsec: {}", e))?;
        let keys = Keys::new(secret_key);

        let recipient_pk = PublicKey::from_hex(recipient_pubkey)
            .map_err(|e| format!("Invalid recipient pubkey: {}", e))?;
        let event_id_parsed = EventId::from_hex(event_id)
            .map_err(|e| format!("Invalid event id: {}", e))?;

        let mut tags = vec![
            Tag::public_key(recipient_pk),
            Tag::event(event_id_parsed),
            Tag::custom(
                TagKind::Custom("amount".into()),
                vec![amount_msats.to_string()],
            ),
        ];

        // Add relays tag
        if !relays.is_empty() {
            let relay_values: Vec<String> = relays.to_vec();
            tags.push(Tag::custom(
                TagKind::Custom("relays".into()),
                relay_values,
            ));
        }

        let event = EventBuilder::new(Kind::ZapRequest, content, tags)
            .to_event(&keys)
            .map_err(|e| format!("Failed to sign zap request: {}", e))?;

        serde_json::to_string(&event)
            .map_err(|e| format!("Failed to serialize zap request: {}", e))
    }

    /// Fetch a BOLT11 invoice from the LNURL callback with the zap request.
    pub async fn fetch_zap_invoice(
        callback: &str,
        amount_msats: u64,
        zap_request_json: &str,
    ) -> Result<String, String> {
        let encoded_zap = urlencoding::encode(zap_request_json);
        let separator = if callback.contains('?') { "&" } else { "?" };
        let url = format!(
            "{}{}amount={}&nostr={}",
            callback, separator, amount_msats, encoded_zap
        );

        let resp = client()
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("LNURL callback failed: {}", e))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("LNURL callback error: {}", body));
        }

        let data: InvoiceCallbackResponse = resp
            .json()
            .await
            .map_err(|e| format!("LNURL callback parse error: {}", e))?;

        data.pr.ok_or_else(|| "No invoice in LNURL callback response".to_string())
    }
}
