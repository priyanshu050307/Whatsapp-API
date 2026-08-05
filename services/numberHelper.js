const logger = require('./logger');

/**
 * Cleans and formats phone numbers for WhatsApp
 * Specifically:
 * - Removes spaces, dashes, brackets, plus signs
 * - Strips leading zeros for Indian numbers
 * - Prefixes 10-digit Indian numbers with 91
 * - Validates format (Indian numbers should be 12 digits, e.g. 91xxxxxxxxxx)
 * - Appends @c.us suffix
 * 
 * @param {string|number} input Mobile number input
 * @returns {string|null} Formatted WhatsApp JID (e.g. 919876543210@c.us) or null if invalid
 */
function sanitizeAndFormatNumber(input) {
  if (!input) return null;
  
  // 1. Convert to string and remove all non-numeric characters except +
  let cleaned = input.toString().replace(/[\s\-\+\(\)]/g, '');

  // 2. Handle leading zero for Indian numbers (e.g. 09876543210 -> 9876543210)
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }

  // 3. Indian phone number formatting
  // If exactly 10 digits (e.g. 9876543210), prefix the country code '91'
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }

  // 4. Validate Indian mobile number pattern
  // After prefixing '91', the total length should be 12.
  // The actual mobile digits (last 10) in India typically start with 5, 6, 7, 8, or 9.
  if (cleaned.length === 12 && cleaned.startsWith('91')) {
    const mobilePart = cleaned.substring(2);
    if (/^[5-9]\d{9}$/.test(mobilePart)) {
      return cleaned + '@c.us';
    }
  }

  // 5. Fallback for other valid international mobile number formats
  // Generally, mobile phone numbers range between 7 to 15 digits.
  if (/^\d{7,15}$/.test(cleaned)) {
    return cleaned + '@c.us';
  }

  logger.warn(`Mobile number format validation failed for raw input: "${input}" (cleaned: "${cleaned}")`);
  return null;
}

module.exports = {
  sanitizeAndFormatNumber
};
