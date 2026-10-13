'use strict';

// One customer-price path (D-013). Stored margin_percent > 1 is a whole percent.
// Stored margin_percent <= 1 is a fraction, so a legacy 1 means 100%.

function customerPrice(base, margin = {}) {
    const baseRate = Number(base) || 0;
    const rawPercent = Number(margin.marginPercent) || 0;
    const marginPercent = rawPercent > 1 ? rawPercent / 100 : rawPercent;
    const marginNumber = Number(margin.marginNumber) || 0;
    return Math.round(baseRate * (1 + marginPercent) + marginNumber);
}

// Whole percents through 100 store as a fraction (10 → 0.10, 100 → 1).
// A fraction above 1 would be read back as a whole percent, so larger inputs
// stay whole numbers and the stored-value heuristic still prices them.
function storedMarginPercent(wholePercent) {
    const value = Number(wholePercent);
    if (value <= 100) return value / 100;
    return value;
}

function displayedMarginPercent(stored) {
    const value = Number(stored);
    if (!Number.isFinite(value)) return 0;
    const whole = value > 1 ? value : value * 100;
    return Math.round(whole * 10000) / 10000;
}

module.exports = {
    customerPrice,
    storedMarginPercent,
    displayedMarginPercent
};
