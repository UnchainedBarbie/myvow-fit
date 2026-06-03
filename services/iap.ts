/**
 * In-app purchase service for MyVow Fit (iOS-only for launch).
 *
 * Built against `expo-iap` — the Expo team's officially-supported IAP module
 * for SDK 54+. Replaces our prior `react-native-iap` integration, which
 * regressed on RN 0.81 / Expo SDK 54 (the v15 release depends on Nitro
 * Modules and v12 hits RCT-Folly incompatibilities on the new architecture).
 *
 * TODO (post-launch): replace client-side trust of Apple's purchase response
 * with server-side receipt validation. expo-iap exposes a `verifyPurchase`
 * helper, but the canonical path is sending the iOS JWS to our own server
 * and verifying with Apple's App Store Server API / Server Notifications.
 * Trusting StoreKit on-device is adequate for v1 but spoofable.
 */
import { Platform } from 'react-native';
import {
  ErrorCode,
  endConnection,
  fetchProducts,
  finishTransaction,
  getActiveSubscriptions,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  restorePurchases as expoRestorePurchases,
} from 'expo-iap';
import type { Purchase } from 'expo-iap';

export const PRODUCT_IDS = [
  'com.anarcobarbie.myvowfit.premium.monthly',
  'com.anarcobarbie.myvowfit.premium.annual',
] as const;

const PRODUCT_ID_LIST: string[] = [...PRODUCT_IDS];

/**
 * Minimal purchase shape we surface to call sites so they don't take a hard
 * dependency on `expo-iap` types. Both `productId` and `expirationDateIOS`
 * are first-class on expo-iap's `PurchaseIOS` interface, so we can rely on
 * them being populated for real subscription purchases.
 */
export type IapPurchase = {
  productId: string;
  transactionId?: string | null;
  expirationDateIOS?: number | null;
  transactionDate?: number;
  [key: string]: unknown;
};

export type PurchaseResult = { success: boolean; error?: string };
export type RestoreResult = {
  success: boolean;
  hasActiveSubscription: boolean;
  error?: string;
};
export type ActiveSubscriptionInfo = {
  isActive: boolean;
  productId?: string;
  expiresAt?: Date;
};

/** Sentinel returned by purchaseSubscription / restorePurchases when the user
 * dismisses the StoreKit sheet. Lets callers branch quietly. */
export const PURCHASE_CANCELLED = 'cancelled';

function isIOS(): boolean {
  return Platform.OS === 'ios';
}

function isCancellationError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  if (code === ErrorCode.UserCancelled) return true;
  if (typeof code === 'string' && code.toLowerCase().includes('cancel')) return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && message.toLowerCase().includes('cancel');
}

function describeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const obj = e as { message?: string; code?: string };
    if (obj.message) return obj.message;
    if (obj.code) return obj.code;
  }
  return 'unknown error';
}

/** Read an expiration timestamp (ms) off any purchase-like shape. Defensive
 * because the StoreKit 2 transaction shape uses `expirationDate` while
 * expo-iap's `PurchaseIOS` exposes `expirationDateIOS`. If neither is present
 * we treat the purchase as active because StoreKit only returns active
 * entitlements in the queue we'll be inspecting. */
function readExpirationMs(p: unknown): number | null {
  if (!p || typeof p !== 'object') return null;
  const anyP = p as Record<string, unknown>;
  const candidates = [anyP.expirationDateIOS, anyP.expirationDate];
  for (const c of candidates) {
    if (c == null) continue;
    const n = typeof c === 'string' ? Number(c) : (c as number);
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Open the native billing connection. Safe to call once at app launch.
 * No product fetch, purchase, or restore happens here — connection only.
 */
export async function initializeIAP(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    console.log('[IAP] Skipping initConnection (not a store platform):', Platform.OS);
    return;
  }
  try {
    const connected = await initConnection();
    if (connected) {
      console.log('[IAP] Connection initialized successfully');
    } else {
      console.warn('[IAP] initConnection completed but returned false');
    }
  } catch (e) {
    console.warn('[IAP] Connection initialization failed:', e);
    throw e;
  }
}

/**
 * Fetch the localized subscription products defined in PRODUCT_IDS. Returns []
 * on any failure so callers can fall back to hardcoded copy.
 */
export async function fetchSubscriptions(): Promise<unknown[]> {
  if (!isIOS()) {
    console.log('[IAP] fetchSubscriptions skipped: non-iOS platform');
    return [];
  }
  try {
    const result = await fetchProducts({ skus: PRODUCT_ID_LIST, type: 'subs' });
    if (!Array.isArray(result)) {
      console.warn('[IAP] fetchSubscriptions: unexpected non-array result');
      return [];
    }
    return result as unknown[];
  } catch (e) {
    console.warn('[IAP] fetchSubscriptions failed:', e);
    return [];
  }
}

/**
 * Kick off a subscription purchase. expo-iap's `requestPurchase` is
 * event-based: it dispatches the StoreKit sheet and the canonical success /
 * error is delivered to our `purchaseUpdatedListener` / `purchaseErrorListener`.
 *
 * We return `{success: true}` purely to indicate the dispatch was accepted.
 * If StoreKit synchronously rejects (e.g. not connected, validation failure)
 * we map that into `{success: false, error}` and translate user cancellation
 * to PURCHASE_CANCELLED so the UI can stay quiet.
 */
export async function purchaseSubscription(productId: string): Promise<PurchaseResult> {
  if (!isIOS()) {
    return { success: false, error: 'IAP is only available on iOS in this build.' };
  }
  if (!productId) {
    return { success: false, error: 'Missing productId' };
  }
  try {
    await requestPurchase({
      request: {
        apple: { sku: productId },
      },
      type: 'subs',
    });
    return { success: true };
  } catch (e) {
    if (isCancellationError(e)) {
      return { success: false, error: PURCHASE_CANCELLED };
    }
    console.warn('[IAP] purchaseSubscription dispatch failed:', e);
    return { success: false, error: describeError(e) };
  }
}

/**
 * Restore previous purchases. expo-iap exposes a dedicated `restorePurchases`
 * helper that performs the iOS sync (StoreKit refresh) without surfacing
 * sync errors, then we inspect the resulting active-subscription list for
 * any of our PRODUCT_IDS.
 */
export async function restorePurchases(): Promise<RestoreResult> {
  if (!isIOS()) {
    return {
      success: false,
      hasActiveSubscription: false,
      error: 'Restore is only available on iOS in this build.',
    };
  }
  try {
    await expoRestorePurchases();
    const active = await getActiveSubscriptions(PRODUCT_ID_LIST);
    const hasActive =
      Array.isArray(active) &&
      active.some(
        (s) =>
          !!s &&
          s.isActive === true &&
          PRODUCT_ID_LIST.includes(s.productId) &&
          !isExpiredFromExpiration(s.expirationDateIOS),
      );
    return { success: true, hasActiveSubscription: hasActive };
  } catch (e) {
    if (isCancellationError(e)) {
      return { success: false, hasActiveSubscription: false, error: PURCHASE_CANCELLED };
    }
    console.warn('[IAP] restorePurchases failed:', e);
    return {
      success: false,
      hasActiveSubscription: false,
      error: describeError(e),
    };
  }
}

function isExpiredFromExpiration(ts: number | null | undefined): boolean {
  if (ts == null) return false;
  return ts <= Date.now();
}

/**
 * Report the current entitlement, if any. expo-iap's `getActiveSubscriptions`
 * returns one `ActiveSubscription` per matching product with `isActive`,
 * `expirationDateIOS`, and `daysUntilExpirationIOS` already computed. We
 * defensively cross-check `expirationDateIOS` so a past timestamp is treated
 * as expired even if the library still reports `isActive: true`.
 */
export async function getActiveSubscription(): Promise<ActiveSubscriptionInfo> {
  if (!isIOS()) {
    return { isActive: false };
  }
  try {
    const subs = await getActiveSubscriptions(PRODUCT_ID_LIST);
    if (!Array.isArray(subs) || subs.length === 0) {
      return { isActive: false };
    }
    const ours = subs.filter((s) => !!s && PRODUCT_ID_LIST.includes(s.productId));
    if (ours.length === 0) {
      return { isActive: false };
    }
    const stillActive = ours.find(
      (s) => s.isActive === true && !isExpiredFromExpiration(s.expirationDateIOS),
    );
    const candidate = stillActive ?? ours[0];
    const expiresMs = readExpirationMs(candidate);
    const expiresAt =
      expiresMs != null && Number.isFinite(expiresMs) ? new Date(expiresMs) : undefined;
    const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false;
    return {
      isActive: !!stillActive && !expired,
      productId: candidate.productId,
      expiresAt,
    };
  } catch (e) {
    console.warn('[IAP] getActiveSubscription failed:', e);
    return { isActive: false };
  }
}

// --- Purchase listeners ----------------------------------------------------

type ListenerSub = { remove: () => void };
let updatedSub: ListenerSub | null = null;
let errorSub: ListenerSub | null = null;

function removeListenersOnly(): void {
  try {
    updatedSub?.remove();
  } catch (e) {
    console.warn('[IAP] removing purchaseUpdated listener failed:', e);
  }
  try {
    errorSub?.remove();
  } catch (e) {
    console.warn('[IAP] removing purchaseError listener failed:', e);
  }
  updatedSub = null;
  errorSub = null;
}

/**
 * Register listeners for the canonical purchase outcome. expo-iap delivers
 * success / error through these subscriptions. We always call
 * `finishTransaction` in the success handler so StoreKit doesn't re-deliver
 * the same purchase on every relaunch.
 *
 * Defensive: any existing listeners are torn down before re-registering so a
 * hot reload doesn't end up with stacked handlers.
 */
export function setupPurchaseListeners(
  onPurchaseSuccess: (purchase: IapPurchase) => void,
  onPurchaseError: (error: { code?: string; message?: string }) => void,
): void {
  if (!isIOS()) {
    console.log('[IAP] setupPurchaseListeners skipped: non-iOS platform');
    return;
  }
  removeListenersOnly();

  try {
    updatedSub = purchaseUpdatedListener(async (purchase: Purchase) => {
      const p = purchase as unknown as IapPurchase;
      console.log('[IAP] purchaseUpdated:', p?.productId, p?.transactionId);
      try {
        onPurchaseSuccess(p);
      } catch (handlerErr) {
        console.warn('[IAP] onPurchaseSuccess handler threw:', handlerErr);
      }
      try {
        // Server-side receipt validation is the right place to gate this in
        // the future (see TODO at top of file). For v1 we trust the device.
        await finishTransaction({ purchase, isConsumable: false });
      } catch (finishErr) {
        console.warn('[IAP] finishTransaction failed:', finishErr);
      }
    });
    errorSub = purchaseErrorListener((error) => {
      const code = (error as { code?: string })?.code;
      const message = (error as { message?: string })?.message;
      console.warn('[IAP] purchaseError:', code, message);
      try {
        onPurchaseError({ code, message });
      } catch (handlerErr) {
        console.warn('[IAP] onPurchaseError handler threw:', handlerErr);
      }
    });
  } catch (e) {
    console.warn('[IAP] setupPurchaseListeners failed to attach:', e);
  }
}

/**
 * Clean up listeners and close the native billing connection. Safe to call
 * multiple times. Called from App.tsx's IAP effect cleanup at unmount.
 */
export function teardownPurchaseListeners(): void {
  removeListenersOnly();
  if (isIOS()) {
    endConnection().catch((e) => console.warn('[IAP] endConnection failed:', e));
  }
}
