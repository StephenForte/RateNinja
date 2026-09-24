const COMPANY_TYPE_CONTRACT_OWNER = 'Contract Owner';
const COMPANY_TYPE_CUSTOMER = 'Freight Forwarder/Customer';
const COMPANY_TYPE_CONTRACT_OWNER_ID = 'contract_owner';
const COMPANY_TYPE_CUSTOMER_ID = 'freight_forwarder_customer';

const SCOPES = ['profile:read', 'rates:read', 'sailings:read'];
const PARTNER_AUDIENCE = 'rn:partner-api';
const CONSENT_VERSION = '1';
const PASSWORD_HASH_VERSION = 'argon2id';
const MIN_PASSWORD_LENGTH = 12;

const KNOWN_COMPANIES = {
    kings: { id: 'kings', name: 'Kings', matchNames: ['Kings', 'Kings Group'] },
    blackwater: { id: 'blackwater-shippers', name: 'Blackwater Shippers', matchNames: ['Blackwater Shippers'] },
    blueSky: { id: 'eceiPwdeF95uwQfD', name: 'Blue Sky Shipping', matchNames: ['Blue Sky Shipping'] }
};

const CAPACITY_EXCHANGE_CLIENT_ID = 'capacity-exchange';
const CAPACITY_EXCHANGE_DISPLAY_NAME = 'Capacity Exchange';

module.exports = {
    COMPANY_TYPE_CONTRACT_OWNER,
    COMPANY_TYPE_CUSTOMER,
    COMPANY_TYPE_CONTRACT_OWNER_ID,
    COMPANY_TYPE_CUSTOMER_ID,
    SCOPES,
    PARTNER_AUDIENCE,
    CONSENT_VERSION,
    PASSWORD_HASH_VERSION,
    MIN_PASSWORD_LENGTH,
    KNOWN_COMPANIES,
    CAPACITY_EXCHANGE_CLIENT_ID,
    CAPACITY_EXCHANGE_DISPLAY_NAME
};
