import Testing

/// Entry point for scripts/test.sh, which builds the tests without SwiftPM or Xcode.
@main
struct TestMain {
    static func main() async {
        await Testing.__swiftPMEntryPoint() as Never
    }
}
