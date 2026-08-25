import vscode from 'vscode';
import type { PricingCurrency } from '../../types';
import { UsageCostTracker, type UsageCostStore } from './tracker';
import { formatMoney, formatUsageCostEstimate, type UsageCostEstimate } from './usage';

const CURRENCIES: readonly PricingCurrency[] = ['USD', 'CNY'];

export class UsageCostStatus implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly tracker: UsageCostTracker;
	private readonly sessionTotals = new Map<PricingCurrency, number>();
	private lastEstimate?: UsageCostEstimate;

	constructor(store: UsageCostStore) {
		this.tracker = new UsageCostTracker(store);
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 92);
		this.item.name = 'OpenCode estimated cost';
		this.item.command = 'opencode-for-copilot.showLogs';
		this.render();
	}

	report(estimate: UsageCostEstimate): void {
		this.lastEstimate = estimate;
		const sessionTotal = (this.sessionTotals.get(estimate.currency) ?? 0) + estimate.totalCost;
		this.sessionTotals.set(estimate.currency, sessionTotal);
		this.tracker.record(estimate.currency, estimate.totalCost);
		this.render();
	}

	private render(): void {
		const currency = this.displayCurrency();
		if (!currency) {
			this.item.hide();
			return;
		}
		const today = this.tracker.dayTotal(currency);
		const month = this.tracker.monthTotal(currency);
		this.item.text =
			'$(graph) OpenCode: ' + formatMoney(today, currency) + ' today \u00b7 ' + formatMoney(month, currency) + ' month';
		this.item.tooltip = this.buildTooltip(currency, today, month);
		this.item.show();
	}

	private displayCurrency(): PricingCurrency | undefined {
		if (this.lastEstimate) {
			return this.lastEstimate.currency;
		}
		return CURRENCIES.find(
			(currency) => this.tracker.dayTotal(currency) > 0 || this.tracker.monthTotal(currency) > 0,
		);
	}

	private buildTooltip(currency: PricingCurrency, today: number, month: number): string {
		const lines: (string | undefined)[] = [
			'OpenCode estimated cost',
			this.lastEstimate ? 'Last turn: ' + formatUsageCostEstimate(this.lastEstimate) : undefined,
			'Today: ' + formatMoney(today, currency),
			'Month: ' + formatMoney(month, currency),
		];
		const sessionTotal = this.sessionTotals.get(currency);
		if (sessionTotal !== undefined) {
			lines.push('Session total: ' + formatMoney(sessionTotal, currency));
		}
		if (this.lastEstimate) {
			const estimate = this.lastEstimate;
			lines.push('Model: ' + estimate.modelName);
			lines.push(
				'Pricing: input ' + formatMoney(estimate.pricing.cacheMissInput, currency)
					+ ' / cached ' + formatMoney(estimate.pricing.cacheHitInput, currency)
					+ ' / output ' + formatMoney(estimate.pricing.output, currency) + ' per 1M tokens',
			);
			if (estimate.pricing.tierLabel) {
				lines.push('Tier: ' + estimate.pricing.tierLabel);
			}
		}
		lines.push('Click to open OpenCode logs.');
		return lines.filter((line): line is string => typeof line === 'string').join('\n');
	}

	dispose(): void {
		this.item.dispose();
	}
}
