import 'package:test/test.dart';
import '../services/code_agent.dart';

void main() {
  group('CodeAgent', () {
    test('unifiedCameraCapture should print stub message', () {
      final agent = CodeAgent();
      // Capture printed output
      expect(() => agent.unifiedCameraCapture(), prints('Camera capture executed (stub).\n'));
    });

    test('CodeAgent is a singleton', () {
      final agent1 = CodeAgent();
      final agent2 = CodeAgent();
      expect(identical(agent1, agent2), isTrue);
    });
  });
}
