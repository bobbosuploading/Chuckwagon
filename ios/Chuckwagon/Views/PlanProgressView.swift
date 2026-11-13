import SwiftUI

/// The waiting screen while a plan is made: what step it's on, and each meal as soon as it's picked.
struct PlanProgressView: View {
    /// Nil until the backend sends its first update (or if it never does, on an older backend).
    var progress: PlanProgress?

    private var stageText: String {
        switch progress?.stage {
        case "thinking": return "Looking over this week's deals…"
        case "meals": return "Picking meals…"
        case "list": return "Writing your grocery list…"
        case "pricing": return "Pricing your list…"
        case "budget": return "Trimming the plan to fit your budget…"
        default: return "Rustling up supper…"
        }
    }

    private var meals: [PlanProgress.ProgressMeal] { progress?.meals ?? [] }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "frying.pan.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Theme.red)
                    .symbolEffect(.bounce, options: .repeating)
                    .padding(.top, meals.isEmpty ? 120 : 40)
                Text(stageText)
                    .font(Theme.title(24))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.center)
                    .contentTransition(.opacity)
                if meals.isEmpty {
                    Text("Matching this week's deals to meals your family will like.")
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                } else {
                    VStack(spacing: 10) {
                        ForEach(Array(meals.enumerated()), id: \.offset) { _, meal in
                            row(meal)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                    .padding(.horizontal, 20)
                }
            }
            .frame(maxWidth: .infinity)
            .animation(.spring(duration: 0.4), value: meals)
            .animation(.easeInOut, value: progress?.stage)
        }
        .background(Theme.cream.ignoresSafeArea())
    }

    private func row(_ meal: PlanProgress.ProgressMeal) -> some View {
        HStack(spacing: 12) {
            Image(systemName: meal.extra ? "lightbulb.fill" : "checkmark.circle.fill")
                .foregroundStyle(meal.extra ? Theme.mustard : Theme.sage)
            VStack(alignment: .leading, spacing: 2) {
                Text(meal.name)
                    .font(Theme.body(.body, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                Text(meal.extra ? "Extra idea · \(meal.timeMinutes) min" : "\(meal.timeMinutes) min")
                    .font(Theme.body(.caption))
                    .foregroundStyle(Theme.ink.opacity(0.6))
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.white, in: RoundedRectangle(cornerRadius: 12))
    }
}
