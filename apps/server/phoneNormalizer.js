/**
 * Phone number normalization — mirrors Chatwoot's PhoneNumberNormalizationService.
 * ref: chatwoot/app/services/whatsapp/phone_normalizers/brazil_phone_normalizer.rb
 *
 * Priority:
 *   1. contactNumber from WA getContactById() — most reliable
 *   2. Derived from @c.us ID — fallback only
 *
 * Rules:
 *   - Reject strings > 15 digits (WA internal IDs like LIDs)
 *   - Brazil (55): 12 digits → add '9' → 13 digits  (pre-2012 numbers missing the 9)
 *   - Display: strip country code 55 for Brazilian numbers
 */

const MAX_PHONE_DIGITS = 15; // ITU-T E.164 cap

/**
 * Normalize a raw number string (digits only) to canonical form.
 * e.g. "5511987654321" stays, "551187654321" (12 digits) → "5511987654321"
 */
function normalizeRaw(raw) {
    if (!raw || raw.length > MAX_PHONE_DIGITS) return null;
    const digits = raw.replace(/\D/g, '');
    if (!digits || digits.length > MAX_PHONE_DIGITS) return null;

    // Brazil: starts with 55, total should be 13 (55+DDD+9+8)
    if (digits.startsWith('55')) {
        if (digits.length === 12) {
            // Missing the '9' digit — insert after DDD (positions 2-3)
            return digits.slice(0, 4) + '9' + digits.slice(4);
        }
        if (digits.length === 13) return digits; // already correct
        if (digits.length === 11) return '55' + digits; // missing country code
        // Any other length for a Brazilian number is suspect — return as-is
    }

    return digits;
}

/**
 * Get display phone (strip Brazilian country code for UI).
 * Returns null if invalid.
 */
function toDisplay(normalized) {
    if (!normalized) return null;
    if (normalized.startsWith('55') && normalized.length >= 12) {
        return normalized.slice(2); // strip +55 for display
    }
    return normalized;
}

/**
 * Main entry point.
 *
 * @param {string} waId       - Full WhatsApp ID, e.g. "5511987654321@c.us"
 * @param {string} [contactNumber] - number field from WA getContactById() if available
 * @returns {string} Display phone (no country code for BR) or '' if undetermined
 */
function resolvePhone(waId, contactNumber) {
    // Prefer contactNumber from WA API — most authoritative
    if (contactNumber) {
        const norm = normalizeRaw(contactNumber);
        const display = toDisplay(norm);
        if (display) return display;
    }

    // Fallback: derive from @c.us ID
    if (waId && waId.endsWith('@c.us')) {
        const raw = waId.replace('@c.us', '');
        const norm = normalizeRaw(raw);
        const display = toDisplay(norm);
        if (display) return display;
    }

    return '';
}

/**
 * Same as resolvePhone but returns the full normalized number (with country code).
 * Used for DB storage — display version is computed client-side.
 */
function resolvePhoneFull(waId, contactNumber) {
    if (contactNumber) {
        const norm = normalizeRaw(contactNumber);
        if (norm) return norm;
    }
    // Never derive phone from @lid — the user part is an internal WA ID, not a phone number
    if (waId && waId.endsWith('@lid')) return null;
    if (waId && waId.endsWith('@c.us')) {
        const raw = waId.replace('@c.us', '');
        const norm = normalizeRaw(raw);
        if (norm) return norm;
    }
    return null;
}

module.exports = { resolvePhone, resolvePhoneFull, normalizeRaw, toDisplay };
