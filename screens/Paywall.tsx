/**
 * Subscription paywall. Calls into services/iap.ts for product fetch, purchase,
 * and restore. The canonical success path is delivered through the purchase
 * listener set up in App.tsx (which dismisses the paywall) — Paywall itself only
 * dispatches the request, manages local loading + error state, and surfaces
 * restore results that don't flow through that listener.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
  Linking,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import {
  PRODUCT_IDS,
  fetchSubscriptions,
  purchaseSubscription,
  restorePurchases,
  PURCHASE_CANCELLED,
} from '../services/iap';

const CREME = '#F5F0E8';
const SAGE = '#A8BEA8';
const TEXT = '#2C2C2C';
const TEXT_MUTED = '#666666';
const BORDER_GREY = '#D4CFC4';
const ERROR_RED = '#B23A3A';

const PURCHASE_TIMEOUT_MS = 30_000;

const VALUE_PROPS = [
  'Sage AI coaching for fitness and nutrition',
  'Personalized meal plans built for you',
  'Smart workout tracking with timers',
  'Vow accountability that fits real life',
] as const;

const MONTHLY_ID = PRODUCT_IDS[0];
const ANNUAL_ID = PRODUCT_IDS[1];

const FALLBACK_MONTHLY_PRICE = '$14.99/mo';
const FALLBACK_ANNUAL_PRICE = '$119/yr';
const FALLBACK_MONTHLY_DISCLAIMER = 'Then $14.99/month. Cancel anytime in Settings.';
const FALLBACK_ANNUAL_DISCLAIMER = 'Then $119/year. Cancel anytime in Settings.';

export type PaywallPlan = 'monthly' | 'annual';

export type PaywallProps = {
  /** Listener-driven error surfaced from outside the paywall (e.g. failed purchase). */
  errorMessage?: string | null;
  /**
   * Called when a restore confirms an active subscription (purchase success has
   * its own dedicated listener wired in App.tsx).
   */
  onSubscriptionActivated?: () => void;
  /** Backwards-compatible callback for the in-app stack route. */
  onContinue?: (plan: PaywallPlan) => void | Promise<void>;
};

type RemoteProduct = {
  productId: string;
  displayPrice?: string;
  /** Optional pre-rendered short label like "$14.99/mo" we synthesize per-period. */
  shortLabel?: string;
  /** Disclaimer copy reused below the CTA. */
  disclaimer?: string;
};

async function openLegalUrl(url: string) {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    await Linking.openURL(url);
  }
}

function periodSuffixForProductId(productId: string): { short: string; disclaimerNoun: string } {
  if (productId === ANNUAL_ID) return { short: '/yr', disclaimerNoun: 'year' };
  return { short: '/mo', disclaimerNoun: 'month' };
}

function normalizeRemoteProducts(raw: unknown[]): Record<string, RemoteProduct> {
  const out: Record<string, RemoteProduct> = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : typeof p.productId === 'string' ? p.productId : null;
    if (!id) continue;
    // v12 (TurboModules) returns `localizedPrice`; v15 used `displayPrice`. We
    // accept either so the paywall renders correctly across library versions.
    const displayPrice =
      typeof p.displayPrice === 'string'
        ? p.displayPrice
        : typeof p.localizedPrice === 'string'
          ? p.localizedPrice
          : undefined;
    if (!displayPrice) continue;
    const suffix = periodSuffixForProductId(id);
    out[id] = {
      productId: id,
      displayPrice,
      shortLabel: `${displayPrice}${suffix.short}`,
      disclaimer: `Then ${displayPrice}/${suffix.disclaimerNoun}. Cancel anytime in Settings.`,
    };
  }
  return out;
}

export default function Paywall({ errorMessage, onSubscriptionActivated, onContinue }: PaywallProps) {
  const { width } = useWindowDimensions();
  const stackPlans = width < 380;
  const [selectedPlan, setSelectedPlan] = useState<PaywallPlan>('annual');
  const [products, setProducts] = useState<Record<string, RemoteProduct>>({});
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [restoreInfo, setRestoreInfo] = useState<string | null>(null);
  const purchaseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const monthlyProductId = MONTHLY_ID;
  const annualProductId = ANNUAL_ID;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await fetchSubscriptions();
        if (cancelled) return;
        const map = normalizeRemoteProducts(remote);
        if (Object.keys(map).length === 0) {
          console.warn('[Paywall] fetchSubscriptions returned no usable products; using fallback copy.');
        }
        setProducts(map);
      } catch (e) {
        console.warn('[Paywall] fetchSubscriptions error:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clear in-flight timeout if the screen unmounts (e.g. listener dismissed paywall).
  useEffect(() => {
    return () => {
      if (purchaseTimeoutRef.current) {
        clearTimeout(purchaseTimeoutRef.current);
        purchaseTimeoutRef.current = null;
      }
    };
  }, []);

  const monthlyProduct = products[monthlyProductId];
  const annualProduct = products[annualProductId];

  const monthlyPriceLabel = monthlyProduct?.shortLabel ?? FALLBACK_MONTHLY_PRICE;
  const annualPriceLabel = annualProduct?.shortLabel ?? FALLBACK_ANNUAL_PRICE;
  const monthlyDisclaimer = monthlyProduct?.disclaimer ?? FALLBACK_MONTHLY_DISCLAIMER;
  const annualDisclaimer = annualProduct?.disclaimer ?? FALLBACK_ANNUAL_DISCLAIMER;

  const disclaimerText = useMemo(
    () => (selectedPlan === 'monthly' ? monthlyDisclaimer : annualDisclaimer),
    [selectedPlan, monthlyDisclaimer, annualDisclaimer],
  );

  // Outer (listener-sourced) error takes precedence over local dispatch errors.
  const surfacedError = errorMessage ?? localError;

  const beginPurchaseTimeout = useCallback(() => {
    if (purchaseTimeoutRef.current) clearTimeout(purchaseTimeoutRef.current);
    purchaseTimeoutRef.current = setTimeout(() => {
      console.warn('[Paywall] purchase outcome did not arrive in 30s; resetting button state.');
      setIsPurchasing(false);
    }, PURCHASE_TIMEOUT_MS);
  }, []);

  const handleCta = useCallback(async () => {
    if (isPurchasing) return;
    setLocalError(null);
    setRestoreInfo(null);
    setIsPurchasing(true);
    beginPurchaseTimeout();

    const productId = selectedPlan === 'monthly' ? monthlyProductId : annualProductId;
    try {
      const result = await purchaseSubscription(productId);
      if (result.success) {
        // Real outcome arrives via the listener wired in App.tsx; keep the button
        // disabled (loading) until the listener dismisses the paywall or 30s passes.
        return;
      }
      if (result.error === PURCHASE_CANCELLED) {
        // User canceled the StoreKit sheet — quiet, just reset the button.
      } else if (result.error) {
        setLocalError(result.error);
      } else {
        setLocalError('Could not start the purchase. Please try again.');
      }
    } catch (e) {
      console.warn('[Paywall] purchase dispatch threw:', e);
      setLocalError('Could not start the purchase. Please try again.');
    }
    if (purchaseTimeoutRef.current) {
      clearTimeout(purchaseTimeoutRef.current);
      purchaseTimeoutRef.current = null;
    }
    setIsPurchasing(false);

    // Backwards-compatible: if a parent provided onContinue (e.g. in-app stack route),
    // we still let it know the user tapped the CTA. This is a no-op on the root paywall.
    if (onContinue) {
      try {
        await onContinue(selectedPlan);
      } catch (e) {
        console.warn('[Paywall] onContinue threw:', e);
      }
    }
  }, [
    annualProductId,
    beginPurchaseTimeout,
    isPurchasing,
    monthlyProductId,
    onContinue,
    selectedPlan,
  ]);

  const handleRestore = useCallback(async () => {
    if (isRestoring) return;
    setLocalError(null);
    setRestoreInfo(null);
    setIsRestoring(true);
    try {
      const result = await restorePurchases();
      if (!result.success) {
        if (result.error && result.error !== PURCHASE_CANCELLED) {
          setLocalError(result.error);
        }
      } else if (result.hasActiveSubscription) {
        onSubscriptionActivated?.();
      } else {
        setRestoreInfo('No active subscription found.');
      }
    } catch (e) {
      console.warn('[Paywall] restore threw:', e);
      setLocalError('Could not restore purchases. Please try again.');
    }
    setIsRestoring(false);
  }, [isRestoring, onSubscriptionActivated]);

  const handleClose = useCallback(() => {
    // Intentionally non-functional in v1: the paywall is the gate.
    console.log('Close paywall');
  }, []);

  const ctaDisabled = isPurchasing || isRestoring;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.headerBar}>
        <View style={styles.headerSpacer} />
        <TouchableOpacity
          onPress={handleClose}
          style={styles.closeBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={28} color={TEXT} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.headline}>Start Your MyVow Fit Journey</Text>
        <Text style={styles.subhead}>14 days free, then choose your plan</Text>

        <View style={styles.bullets}>
          {VALUE_PROPS.map((line) => (
            <View key={line} style={styles.bulletRow}>
              <Ionicons name="checkmark-circle" size={22} color={SAGE} style={styles.bulletIcon} />
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.planSectionLabel}>Choose your plan</Text>
        <View style={[styles.planRow, stackPlans && styles.planRowStacked]}>
          <TouchableOpacity
            style={[
              styles.planCard,
              stackPlans && styles.planCardStacked,
              selectedPlan === 'monthly' ? styles.planCardSelected : styles.planCardUnselected,
            ]}
            onPress={() => setSelectedPlan('monthly')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedPlan === 'monthly' }}
            disabled={ctaDisabled}
          >
            <View style={styles.monthlyBadgeSpacer} />
            <Text style={styles.planCardTitle}>Monthly</Text>
            <Text style={styles.planPrice}>{monthlyPriceLabel}</Text>
            <Text style={styles.planFinePrint}>Billed monthly</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.planCard,
              stackPlans && styles.planCardStacked,
              selectedPlan === 'annual' ? styles.planCardSelected : styles.planCardUnselected,
            ]}
            onPress={() => setSelectedPlan('annual')}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedPlan === 'annual' }}
            disabled={ctaDisabled}
          >
            <View style={styles.badgeCenterWrap}>
              <View style={styles.bestValueBadge}>
                <Text style={styles.bestValueBadgeText}>BEST VALUE</Text>
              </View>
            </View>
            <Text style={styles.planCardTitle}>Annual</Text>
            <Text style={styles.planPrice}>{annualPriceLabel}</Text>
            <Text style={styles.planFinePrint}>Save 33% · Billed yearly</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.cta, ctaDisabled && styles.ctaDisabled]}
          onPress={handleCta}
          activeOpacity={0.9}
          disabled={ctaDisabled}
        >
          {isPurchasing ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.ctaText}>Start 14-Day Free Trial</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.disclaimer}>{disclaimerText}</Text>

        <TouchableOpacity
          onPress={handleRestore}
          style={styles.restoreWrap}
          hitSlop={8}
          disabled={ctaDisabled}
        >
          {isRestoring ? (
            <ActivityIndicator color={SAGE} />
          ) : (
            <Text style={[styles.restoreText, ctaDisabled && { opacity: 0.5 }]}>
              Restore Purchases
            </Text>
          )}
        </TouchableOpacity>

        {restoreInfo != null && (
          <Text style={styles.restoreInfo}>{restoreInfo}</Text>
        )}
        {surfacedError != null && surfacedError !== '' && (
          <Text style={styles.errorText} numberOfLines={2}>
            {surfacedError}
          </Text>
        )}

        <View style={styles.legalRow}>
          <TouchableOpacity
            onPress={() => {
              void Linking.openURL(
                'https://unchainedbarbie.github.io/myvow-fit-legal/privacy.html',
              );
            }}
          >
            <Text style={styles.legalLink}>Privacy Policy</Text>
          </TouchableOpacity>
          <Text style={styles.legalSep}> · </Text>
          <TouchableOpacity
            onPress={() => {
              void Linking.openURL(
                'https://unchainedbarbie.github.io/myvow-fit-legal/terms.html',
              );
            }}
          >
            <Text style={styles.legalLink}>Terms of Use</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: CREME,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingBottom: 4,
    minHeight: 44,
  },
  headerSpacer: { flex: 1 },
  closeBtn: {
    padding: 8,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === 'ios' ? 32 : 24,
  },
  headline: {
    fontFamily: 'CormorantGaramond-Bold',
    fontSize: 34,
    lineHeight: 40,
    color: TEXT,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  subhead: {
    fontFamily: 'Jost_500Medium',
    fontSize: 18,
    lineHeight: 26,
    color: '#444444',
    textAlign: 'center',
    marginBottom: 28,
  },
  bullets: {
    marginBottom: 28,
    gap: 14,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  bulletIcon: {
    marginTop: 2,
  },
  bulletText: {
    flex: 1,
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: '#333333',
  },
  planSectionLabel: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 14,
    color: TEXT_MUTED,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  planRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  planRowStacked: {
    flexDirection: 'column',
  },
  planCard: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 14,
    backgroundColor: '#FFFCF7',
    minHeight: 148,
  },
  planCardStacked: {
    flex: 0,
    width: '100%',
  },
  planCardUnselected: {
    borderWidth: 1,
    borderColor: BORDER_GREY,
  },
  planCardSelected: {
    borderWidth: 2,
    borderColor: SAGE,
  },
  monthlyBadgeSpacer: {
    height: 26,
  },
  badgeCenterWrap: {
    alignItems: 'center',
    marginBottom: 6,
  },
  bestValueBadge: {
    backgroundColor: SAGE,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  bestValueBadgeText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 10,
    letterSpacing: 0.6,
    color: '#FFFFFF',
  },
  planCardTitle: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 16,
    color: TEXT,
    marginBottom: 8,
    marginTop: 4,
  },
  planPrice: {
    fontFamily: 'CormorantGaramond-Bold',
    fontSize: 26,
    color: TEXT,
    marginBottom: 6,
  },
  planFinePrint: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    color: TEXT_MUTED,
    lineHeight: 18,
  },
  cta: {
    backgroundColor: SAGE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    minHeight: 52,
  },
  ctaDisabled: {
    opacity: 0.7,
  },
  ctaText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 17,
    color: '#FFFFFF',
  },
  disclaimer: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    lineHeight: 19,
    color: TEXT_MUTED,
    textAlign: 'center',
    marginBottom: 20,
  },
  restoreWrap: {
    alignSelf: 'center',
    marginBottom: 12,
    minHeight: 24,
    justifyContent: 'center',
  },
  restoreText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
    color: SAGE,
  },
  restoreInfo: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    color: TEXT_MUTED,
    textAlign: 'center',
    marginBottom: 12,
  },
  errorText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 13,
    lineHeight: 18,
    color: ERROR_RED,
    textAlign: 'center',
    marginBottom: 16,
  },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingTop: 8,
    paddingBottom: 8,
  },
  legalLink: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    color: TEXT_MUTED,
    textDecorationLine: 'underline',
  },
  legalSep: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    color: TEXT_MUTED,
  },
});
