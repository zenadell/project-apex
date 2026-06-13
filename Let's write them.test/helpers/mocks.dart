import 'package:mockito/mockito.dart';
import '../../database/database.dart';
import '../../cache/cache.dart';
import '../../services/code_agent.dart';
import '../../config/config.dart';

class MockDatabase extends Mock implements Database {}
class MockCache extends Mock implements Cache {}
class MockCodeAgent extends Mock implements CodeAgent {}
class MockConfig extends Mock implements Config {}
