import SwiftUI

extension ProductCountry {
    static func flag(_ code: String) -> String {
        String(String.UnicodeScalarView(code.unicodeScalars.compactMap { UnicodeScalar(0x1F1A5 + $0.value) }))
    }
    static func name(_ code: String) -> String { Locale.current.localizedString(forRegionCode: code) ?? code }
}

/// Opens a searchable list of every product country with its flag.
struct CountryPicker: View {
    let title: String
    @Binding var selection: String
    var body: some View {
        NavigationLink {
            CountryList(selection: $selection).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        } label: {
            LabeledContent(title, value: ProductCountry.isValid(selection) ? ProductCountry.flag(selection) + " " + ProductCountry.name(selection) : selection)
        }
    }
}

private struct Country: Identifiable {
    let code: String; let name: String
    var id: String { code }
}

private struct CountryList: View {
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    private let countries = ProductCountry.codes.map { Country(code: $0, name: ProductCountry.name($0)) }
        .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    private var matches: [Country] {
        let text = query.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? countries : countries.filter { $0.name.localizedStandardContains(text) || $0.code.caseInsensitiveCompare(text) == .orderedSame }
    }
    var body: some View {
        ScrollViewReader { proxy in
            List(matches) { country in
                Button { selection = country.code; dismiss() } label: {
                    HStack {
                        Text(ProductCountry.flag(country.code)).accessibilityHidden(true)
                        Text(country.name).foregroundStyle(.primary)
                        Spacer()
                        if country.code == selection { Image(systemName: "checkmark").foregroundStyle(.tint) }
                    }
                }.accessibilityAddTraits(country.code == selection ? .isSelected : [])
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("Search countries"))
            .onAppear { proxy.scrollTo(selection, anchor: .center) }
        }
    }
}
