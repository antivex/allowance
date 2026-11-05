/** The subset of PayPal REST shapes Allowance reads. Field names follow the PayPal API. */

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface Capture {
  id: string;
  status: string;
  amount?: Money;
  final_capture?: boolean;
  status_details?: { reason?: string };
  create_time?: string;
}

export interface Authorization {
  id: string;
  status: string;
  amount?: Money;
  expiration_time?: string;
  status_details?: { reason?: string };
  create_time?: string;
}

export interface PurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  amount?: Money;
  payments?: {
    captures?: Capture[];
    authorizations?: Authorization[];
  };
}

export interface Order {
  id: string;
  status: string;
  intent?: string;
  purchase_units?: PurchaseUnit[];
  payment_source?: {
    paypal?: {
      email_address?: string;
      account_id?: string;
    };
  };
  links?: Link[];
}

export interface SetupToken {
  id: string;
  status: string;
  customer?: { id: string };
  links?: Link[];
}

export interface PaymentToken {
  id: string;
  customer?: { id: string };
  payment_source?: {
    paypal?: {
      email_address?: string;
      payer_id?: string;
      name?: { given_name?: string; surname?: string };
    };
  };
}

export interface OrderItem {
  name: string;
  quantity: string;
  unit_amount: Money;
  category?: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'DONATION';
}

export interface CreateOrderBody {
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchase_units: Array<{
    reference_id: string;
    custom_id: string;
    invoice_id: string;
    description: string;
    amount: Money & { breakdown: { item_total: Money } };
    items: OrderItem[];
    /** Who receives the money. Left out, PayPal pays the REST app's own business account. */
    payee?: { email_address: string };
  }>;
  payment_source: { paypal: { vault_id: string } };
}

/** PayPal error body: https://developer.paypal.com/api/rest/responses/ */
export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: Array<{ issue?: string; description?: string; field?: string }>;
  error?: string;
  error_description?: string;
}
